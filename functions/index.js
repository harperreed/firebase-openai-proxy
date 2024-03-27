const functions = require('firebase-functions');
const { onRequest } = require("firebase-functions/v2/https");
const axios = require('axios');
const admin = require('firebase-admin');
const crypto = require('crypto');
const logger = require("firebase-functions/logger");
const { Timestamp } = require("firebase-admin/firestore");
admin.initializeApp();

const db = admin.firestore();

/**
 * Helper function to calculate the cost based on tokens and rate.
 *
 * @param {number} tokens - The number of tokens.
 * @param {number} rate - The rate per 1000 tokens.
 * @return {string} The calculated cost, rounded to four decimal places.
 */
const calculateCost = (tokens, rate) => parseFloat(tokens * rate / 1000);

/**
 * Replaces the middle half of a string with periods.
 * @param {string} str - The original string.
 * @returns {string} - The modified string with the middle half replaced by periods.
 */
function replaceMiddleWithPeriods(str) {
  const len = str.length;
  const start = Math.floor(len / 4);
  const end = Math.ceil(3 * len / 4);
  return str.substring(0, start) + '.'.repeat(end - start) + str.substring(end);
}

/**
 * Fetch available models from the OpenAI API and store them in Firestore with default pricing.
 * Logs detailed information about the request and response for debugging and tracking purposes.
 * @async
 * @returns {Promise<void>} A promise that resolves when the models have been loaded to Firestore.
 */
async function loadModelsToFirestore() {
  try {
    const targetUrl = 'https://api.openai.com/v1/models';
    const auth = process.env.OPENAI_API_KEY;

    if (!auth) {
      logger.error('OpenAI API key is not set in environment variables.');
      throw new Error('OpenAI API key not found.');
    }

    logger.info(`Fetching available models from OpenAI API.`);
    const response = await axios.get(targetUrl, {
      headers: { 'Authorization': `Bearer ${auth}` }
    });

    logger.debug('Response from OpenAI API received:', response.data);
    const models = response.data.data;

    // Set default pricing values
    const defaultPricePer1000TokensInput = 0.03;
    const defaultPricePer1000TokensOutput = 0.06;

    // Store models in Firestore
    for (const model of models) {
      const modelName = model.id;
      logger.debug(`Processing model: ${modelName}`);

      // Check if the model already exists in Firestore
      const pricingDocRef = db.collection('pricing').doc(modelName);
      const pricingDoc = await pricingDocRef.get();

      if (!pricingDoc.exists) {
        // Model does not exist, create a new document
        await pricingDocRef.set({
          model_name: modelName,
          pricePer1000TokensInput: defaultPricePer1000TokensInput,
          pricePer1000TokensOutput: defaultPricePer1000TokensOutput,
          createdAt: Timestamp.now(),
          modifiedAt: Timestamp.now(), // Initially, createdAt and modifiedAt are the same
        });

        logger.info(`Model ${modelName} added with default pricing.`);
      } else {
        logger.info(`Model ${modelName} already exists in Firestore. Skipping.`);
      }
    }

    logger.info('All models loaded to Firestore successfully.');
  } catch (error) {
    logger.error('Error while loading models to Firestore:', error);
    if (error.response) {
      // Server responded with a non-2xx status code
      logger.error('Server Error:', error.response.data);
    } else if (error.request) {
      // No response received, likely a network issue
      logger.error('Network Error:', error.request);
    } else {
      // Something else happened while setting up the request
      logger.error('Request Error:', error.message);
    }
    throw error;
  }
}

/**
 * Determine the pricing for input and output tokens based on the model name.
 * Retrieves pricing data from the Firestore 'pricing' collection for the specified model.
 * If the model pricing is not found, default pricing is applied.
 *
 * @async
 * @param {string} model - The name of the model being used.
 * @returns {Promise<{pricePer1000TokensInput: number, pricePer1000TokensOutput: number}>} An object containing the pricing per 1000 input tokens and per 1000 output tokens.
 */
async function determinePricing(model) {
  const defaultPricing = { pricePer1000TokensInput: 0.03, pricePer1000TokensOutput: 0.06 };
  try {
    const pricingQuerySnapshot = await db.collection('pricing').where('model_name', '==', model).limit(1).get();

    if (!pricingQuerySnapshot.empty) {
      const pricingData = pricingQuerySnapshot.docs[0].data();
      const { pricePer1000TokensInput, pricePer1000TokensOutput } = pricingData;
      logger.info(`Retrieved pricing for ${model}: $${pricePer1000TokensInput} per 1000 input tokens, $${pricePer1000TokensOutput} per 1000 output tokens`);
      return { pricePer1000TokensInput, pricePer1000TokensOutput };
    } else {
      logger.warn(`Pricing for model "${model}" not found, using default pricing.`);
      return defaultPricing;
    }
  } catch (error) {
    logger.error(`Error fetching pricing data for model "${model}": ${error.message}`, error);
    return defaultPricing;
  }
}

/**
 * Calculate and log the cost details for using a specific OpenAI model.
 * The function also stores this information in a Firestore collection.
 * It logs detailed information for transparency and debugging.
 *
 * @async
 * @param {Object} response - Object containing OpenAI API response.
 * @param {string} model - The name of the OpenAI model used.
 * @param {admin.firestore.DocumentReference} cacheDocRef - Firestore document reference to store usage data.
 */
async function trackCosts(response, model, cacheDocRef) {
  if (!response || !response.usage) {
    logger.warn("Invalid response object provided to trackCosts function.");
    return;
  }

  const { usage } = response;

  // Retrieve pricing for the given model.
  const pricing = await determinePricing(model);

  // Calculate costs based on usage and pricing.
  const promptCost = calculateCost(usage.prompt_tokens, pricing.pricePer1000TokensInput);
  const outputCost = calculateCost(usage.completion_tokens, pricing.pricePer1000TokensOutput);
  const totalCost = promptCost + outputCost;

  // Log cost details for transparency.
  logger.info(`Model: ${model}`);
  logger.info(`Prompt Tokens: ${usage.prompt_tokens}, Cost: $${promptCost.toFixed(4)}`);
  logger.info(`Completion Tokens: ${usage.completion_tokens}, Cost: $${outputCost.toFixed(4)}`);
  logger.info(`Total Cost: $${totalCost.toFixed(4)}`);

  // Add total cost to the usage object for storage.
  usage["total_cost"] = totalCost;

  // Retrieve the API key from the cache document for tracking purposes.
  const docData = (await cacheDocRef.get()).data();
  const apikey = docData && docData.apikey ? docData.apikey : 'Unknown';

  // Create an object to store in the 'openaiUsage' collection.
  const usageObject = {
    createdAt: Timestamp.now(),
    model,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    pricePer1000TokensInput: pricing.pricePer1000TokensInput,
    pricePer1000TokensOutput: pricing.pricePer1000TokensOutput,
    promptCost,
    outputCost,
    totalCost,
    apikey, // Store the obfuscated API key for tracking.
  };

  // Store the usage data in Firestore.
  await db.collection("openaiUsage").add(usageObject);
}

exports.openAIProxy = onRequest(async (req, res) => {
  // Check for proper authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Bad Request: Missing or malformed authorization header.');
    res.status(400).send('Bad Request: Missing or malformed authorization header');
    return;
  }

  // Extract the Bearer token and model from the request
  const auth = authHeader.split(' ')[1];
  let model = req.body.model || "utility";

  // Hash the authorization and parameters for cache identification
  const authHash = crypto.createHash('md5').update(auth).digest('hex');
  const paramsHash = crypto.createHash('md5').update(JSON.stringify(req.body)).digest('hex');
  const cachePath = `cache/${authHash}/${model}/${paramsHash}`;

  // Check cache for existing response
  const cacheDoc = db.doc(cachePath);
  const doc = await cacheDoc.get();
  const currentTime = Date.now();

  if (doc.exists) {
    const cachedData = doc.data();
    const cacheTime = cachedData.timestamp;

    // Validate cache freshness (1 minute)
    if (currentTime - cacheTime < 60000) {
      logger.info(`Cache hit for ${req.url}.`);
      res.header('Cache-Control', 'public, max-age=60, s-maxage=60');
      res.header("Content-Type", "application/json");
      res.status(200).send(JSON.stringify(cachedData.response));
      return;
    } else {
      logger.info(`Cache expired for ${req.url}. Refetching.`);
    }
  }

  try {
    // Construct the OpenAI URL for proxying the request
    const targetUrl = `https://api.openai.com${req.url}`;
    logger.info(`Proxying request to OpenAI API: ${targetUrl}`);

    // Prepare the request object for axios
    const requestObject = {
      url: targetUrl,
      method: req.method,
      headers: { 'Authorization': `Bearer ${auth}` },
    };

    // Include request body for POST requests
    if (req.method === 'POST') {
      requestObject.data = req.body;
    }

    // Log the request object for debugging
    logger.debug('Request object for axios:', requestObject);

    // Perform the request to OpenAI API
    const response = await axios(requestObject);
    const responseData = response.data;

    // Log the response data for debugging
    logger.debug('Response data from OpenAI API:', responseData);

    // Calculate and log token usage if present in response
    let tokensUsed = responseData.usage?.total_tokens || 0;
    logger.info(`Tokens used for the request: ${tokensUsed}`);

    // Store the response in the cache with obfuscated API key and additional metadata
    await cacheDoc.set({
      request: {
        url: targetUrl,
        method: req.method,
        headers: { 'Authorization': `Bearer ${replaceMiddleWithPeriods(auth)}` },
        body: req.body
      },
      response: responseData,
      model: model,
      apikey: replaceMiddleWithPeriods(auth),
      authHash,
      tokensUsed: tokensUsed,
      timestamp: currentTime,
      lastModified: Timestamp.now(),
    });

    // Track costs if usage data is available
    if (responseData.usage) {
      await trackCosts(responseData, model, cacheDoc);
    }

    // Send the response back to the client
    res.status(200).send(responseData);
  } catch (error) {
    // Handle errors from OpenAI API or network issues
    if (error.response) {
      logger.error('Error response from OpenAI API:', error.response.data);
      res.headers = error.response.headers;
      res.status(error.response.status).send(error.response.data);
    } else if (error.request) {
      logger.error('Network error while making request to OpenAI API:', error.request);
      res.status(500).send('Network Error');
    } else {
      logger.error('Error in setting up request:', error.message);
      res.status(500).send('Internal Server Error');
    }
  }
});

exports.getOpenAIUsage = onRequest(async (req, res) => {
  // Begin processing the request to get OpenAI usage data
  logger.info('Received request to retrieve OpenAI usage data.');

  try {
    // Fetch OpenAI usage data from Firestore, ordered by creation time in descending order
    const snapshot = await db.collection('openaiUsage').orderBy('createdAt', 'desc').get();

    // Transform the data from Firestore documents to a more readable format
    const data = snapshot.docs.map(doc => {
      const docData = doc.data();
      const createdDate = docData.createdAt.toDate().toISOString();

      // Extract the cache document ID if available
      const cacheId = docData.cacheDoc ? docData.cacheDoc.id : 'NoCacheId';

      // Remove the cacheDoc reference from the data to prevent sending Firestore references to the client
      delete docData.cacheDoc;

      // Log the usage data for the current document
      logger.debug(`OpenAI usage data for cache ID ${cacheId}:`, docData);

      return {
        ...docData,
        createdAt: createdDate,
        cacheId,
      };
    });

    // Send the transformed data back to the client as JSON
    logger.info('Successfully retrieved OpenAI usage data.');
    res.status(200).json(data);
  } catch (error) {
    // Log the error details
    logger.error('Failed to retrieve OpenAI usage data:', error);

    // Send a 500 Internal Server Error response to the client
    res.status(500).send('Internal Server Error');
  }
});


exports.loadOpenAIModels = onRequest(async (req, res) => {

  try {
    await loadModelsToFirestore();
    res.status(200).send('OK');
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }

})
