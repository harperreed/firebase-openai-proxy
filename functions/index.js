const functions = require("firebase-functions");
const { onRequest } = require("firebase-functions/v2/https");
const axios = require("axios");
const admin = require("firebase-admin");
const crypto = require("crypto");
const logger = require("firebase-functions/logger");
const { Timestamp } = require("firebase-admin/firestore");
admin.initializeApp();

const db = admin.firestore();

// Helper function to calculate the cost based on tokens and rate
const calculateCost = (tokens, rate) => parseFloat((tokens * rate) / 1000);

// Replaces the middle half of a string with periods
function replaceMiddleWithPeriods(str) {
    const len = str.length;
    const start = Math.floor(len / 4);
    const end = Math.ceil((3 * len) / 4);
    return str.substring(0, start) + ".".repeat(end - start) + str.substring(end);
}

// Fetch available models from the OpenAI API and store them in Firestore with default pricing
async function loadOpenAiModelsToFirestore() {
    try {
        const targetUrl = "https://api.openai.com/v1/models";
        const auth = process.env.OPENAI_API_KEY;

        const requestObject = {
            url: targetUrl,
            method: "GET",
            headers: { Authorization: `Bearer ${auth}` },
        };

        const response = await axios(requestObject);
        const models = response.data.data;

        // Set default pricing values
        const defaultPricePer1000TokensInput = 0.03;
        const defaultPricePer1000TokensOutput = 0.06;

        // Store models in Firestore
        for (const model of models) {
            const modelName = model.id;

            // Check if the model already exists in Firestore
            const pricingDoc = await db
                .collection("pricing")
                .where("model_name", "==", modelName)
                .get();

            if (pricingDoc.empty) {
                // Model does not exist, create a new document
                await db.collection("pricing").doc(modelName).set({
                    model_name: modelName,
                    pricePer1000TokensInput: defaultPricePer1000TokensInput,
                    pricePer1000TokensOutput: defaultPricePer1000TokensOutput,
                    createdAt: Timestamp.now(),
                    modifiedAt: Timestamp.now(),
                });

                logger.info(`Model ${modelName} added with default pricing.`);
            } else {
                logger.info(`Model ${modelName} already exists in Firestore.`);
            }
        }

        logger.info("All models loaded to Firestore.");
    } catch (error) {
        logger.error("Error loading models to Firestore:", error);
        throw error;
    }
}

// Determine the pricing for input and output tokens based on the model name
async function determinePricing(model) {
    try {
        const pricingDoc = await db
            .collection("pricing")
            .where("model_name", "==", model)
            .get();

        if (!pricingDoc.empty) {
            const pricingData = pricingDoc.docs[0].data();
            const { pricePer1000TokensInput, pricePer1000TokensOutput } = pricingData;
            logger.info(
                `Pricing for ${model}: $${pricePer1000TokensInput} per 1000 input tokens, $${pricePer1000TokensOutput} per 1000 output tokens`,
            );
            return [pricePer1000TokensInput, pricePer1000TokensOutput];
        } else {
            // Model not found in Firestore, return default pricing
            logger.info(`Pricing for ${model} not found, using default pricing`);
            return [0.03, 0.06];
        }
    } catch (error) {
        logger.info(`Error fetching pricing data for ${model}, using default pricing`);
        throw error;
    }
}

// Calculate and log the cost details for using a specific OpenAI model
async function trackOpenAiCosts(response, model, cacheDoc) {
    if (!response || !response.usage) {
        logger.warn("Invalid response object");
        return;
    }

    const { usage } = response;

    // Use the function to get pricing
    const [pricePer1000TokensInput, pricePer1000TokensOutput] = await determinePricing(model);

    const promptCost = calculateCost(usage.prompt_tokens, pricePer1000TokensInput);
    const outputCost = calculateCost(usage.completion_tokens, pricePer1000TokensOutput);
    const totalCost = parseFloat(promptCost + outputCost);

    logger.info(`Total Cost for ${model} prompt: $${totalCost}`);
    logger.info(`Prompt Tokens: ${usage.prompt_tokens} ($${promptCost})`);
    logger.info(`Output Tokens: ${usage.completion_tokens} ($${outputCost})`);

    usage["total_cost"] = totalCost;

    // Read apikey from cacheDoc
    const docData = await cacheDoc.get();
    const apikey = docData.exists ? docData.data().apikey : null;

    const usageObject = {
        createdAt: Timestamp.now(),
        model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        pricePer1000TokensInput,
        pricePer1000TokensOutput,
        promptCost,
        outputCost,
        totalCost: usage.total_cost,
        cacheDoc: cacheDoc,
        apikey,
    };

    await db.collection("openaiUsage").add(usageObject);
}

exports.openAIProxy = onRequest(async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(400).send("Bad Request: Missing or malformed authorization header");
        return;
    }

    let model = "utility";
    if ("model" in req.body) {
        model = req.body.model;
    }

    const auth = authHeader.split(" ")[1];
    const authHash = crypto.createHash("md5").update(auth).digest("hex");
    const paramsHash = crypto
        .createHash("md5")
        .update(JSON.stringify(req.body))
        .digest("hex");
    const cachePath = `cache/${authHash}/${model}/${paramsHash}`;

    const cacheDoc = db.doc(cachePath);
    const doc = await cacheDoc.get();

    const currentTime = Date.now();

    if (doc.exists) {
        const cachedData = doc.data();
        const cacheTime = cachedData.timestamp;

        // Check if cache is still valid (less than 1 minute old)
        if (currentTime - cacheTime < 60000) {
            logger.info(`Cache hit for ${req.url}`);
            res.header("Cache-Control", "public, max-age=60, s-maxage=60");
            res.header("Content-Type", "application/json");
            res.status(200).send(JSON.stringify(cachedData.response));
            return;
        }
    }

    try {
        const targetUrl = `https://api.openai.com${req.url}`;
        logger.info(`Proxying request to ${targetUrl}`);

        const requestObject = {
            url: targetUrl,
            method: req.method,
            headers: { Authorization: `Bearer ${auth}` },
        };
        if (req.method === "POST") {
            requestObject.data = req.body;
        }

        const response = await axios(requestObject);
        const responseData = response.data;
        let tokensUsed = 0;
        if ("usage" in responseData) {
            tokensUsed = responseData["usage"]["total_tokens"];
        }

        // Save request and response details, model, tokens used, and timestamp to cache
        await cacheDoc.set({
            request: {
                url: targetUrl,
                method: req.method,
                headers: {
                    Authorization: `Bearer ${replaceMiddleWithPeriods(auth)}`,
                },
                body: req.body,
            },
            response: responseData,
            model: model,
            apikey: replaceMiddleWithPeriods(auth),
            authHash,
            tokensUsed,
            timestamp: currentTime,
            lastModified: Timestamp.now(),
        });

        if ("usage" in responseData && model) {
            await trackOpenAiCosts(responseData, model, cacheDoc);
        }

        res.status(200).send(responseData);
    } catch (error) {
        if (error.response) {
            res.headers = error.response.headers;
            res.status(error.response.status).send(error.response.data);
            return;
        } else if (error.request) {
            logger.error(error.request);
        } else {
            logger.error("Error", error.message);
        }
        logger.error(error.config);

        res.status(500).send("Internal Server Error");
    }
});

exports.anthropicProxy = onRequest(async (req, res) => {
    if (!req.headers["x-api-key"]) {
        res.status(400).send("Bad Request: Missing API key");
        return;
    }
    const { "x-api-key": apiKey, "anthropic-version": version, ...headers } = req.headers;
    const { body, method, url } = req;
    logger.info(`Anthropic version: ${version}`);
    logger.info(`API Key: ${replaceMiddleWithPeriods(apiKey)}`);

    let model = "utility";
    if ("model" in body) {
        model = body.model;
    }

    logger.debug(`Model selected: ${model}`);

    const authHash = crypto.createHash("md5").update(apiKey).digest("hex");
    const paramsHash = crypto
        .createHash("md5")
        .update(JSON.stringify(body))
        .digest("hex");
    const cachePath = `cache/${authHash}/${model}/${paramsHash}`;

    logger.debug(`Cache path: ${cachePath}`);

    const cacheDoc = db.doc(cachePath);
    const doc = await cacheDoc.get();

    const currentTime = Date.now();

    if (doc.exists) {
        const cachedData = doc.data();
        const cacheTime = cachedData.timestamp;

        logger.debug(`Cache document exists. Cache time: ${cacheTime}`);

        // Check if cache is still valid (less than 1 minute old)
        if (currentTime - cacheTime < 60000) {
            logger.info(`Cache hit for ${url}`);
            res.header("Cache-Control", "public, max-age=60, s-maxage=60");
            res.header("Content-Type", "application/json");
            res.status(200).send(JSON.stringify(cachedData.response));
            return;
        } else {
            logger.debug(`Cache expired for ${url}`);
        }
    } else {
        logger.debug(`No cache document found for ${url}`);
    }

    try {
        const targetUrl = `https://api.anthropic.com/${url}`;
        logger.info(`Proxying request to ${targetUrl}`);

        const targetHeaders = {
            "x-api-key": apiKey,
            "Anthropic-Version": version,
        };
        const requestObject = {
            url: targetUrl,
            method: method,
            headers: targetHeaders,
        };
        if (req.method === "POST") {
            requestObject.data = body;
        }

        const response = await axios(requestObject);
        const responseData = response.data;
        let tokensUsed = 0;
        if ("usage" in responseData) {
            tokensUsed = responseData["usage"]["input_tokens"] + responseData["usage"]["output_tokens"];
            logger.debug(`Tokens used: ${tokensUsed}`);
        }

        // Save request and response details, model, tokens used, and timestamp to cache
        await cacheDoc.set({
            request: {
                url: targetUrl,
                method: method,
                headers: targetHeaders,
                body: body,
            },
            response: responseData,
            model: model,
            apikey: replaceMiddleWithPeriods(apiKey),
            authHash,
            tokensUsed,
            timestamp: currentTime,
            lastModified: Timestamp.now(),
        });

        logger.info(`Response cached for ${url}`);

        res.status(200).send(responseData);
    } catch (error) {
        logger.error(`Error during request to ${url}: ${error.message}`);
        if (error.response) {
            res.headers = error.response.headers;
            res.status(error.response.status).send(error.response.data);
            return;
        } else if (error.request) {
            logger.error(`No response received for ${url}: ${error.request}`);
        } else {
            logger.error("Error", error.message);
        }
        logger.error(`Request config: ${JSON.stringify(error.config)}`);

        res.status(500).send("Internal Server Error");
    }
});

exports.getOpenAIUsage = onRequest(async (req, res) => {
    try {
        const snapshot = await db
            .collection("openaiUsage")
            .orderBy("createdAt", "desc")
            .get();

        const data = snapshot.docs.map((doc) => {
            const docData = doc.data();
            const createdDate = docData.createdAt.toDate().toISOString();
            const cacheId = docData.cacheDoc.id;

            delete docData.cacheDoc;

            return {
                ...docData,
                createdAt: createdDate,
                cacheId,
            };
        });

        res.status(200).json(data);
    } catch (error) {
        console.error(error);
        res.status(500).send("Internal Server Error");
    }
});

exports.loadOpenAIModels = onRequest(async (req, res) => {
    try {
        await loadOpenAiModelsToFirestore();
        res.status(200).send("OK");
    } catch (error) {
        console.error(error);
        res.status(500).send("Internal Server Error");
    }
});
