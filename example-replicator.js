const {
  Message,
  isCastAddMessage,
  fromFarcasterTime,
} = require("@farcaster/hub-nodejs");
const { Casts, Messages } = require("./models/farcaster");

/**
 * Helper function to convert byte arrays to hex strings
 */
function bytesToHex(bytes) {
  if (bytes === undefined) return undefined;
  if (bytes === null) return null;
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/**
 * Helper function to convert Farcaster timestamp to JavaScript Date
 */
function farcasterTimeToDate(time) {
  if (time === undefined) return undefined;
  if (time === null) return null;
  const result = fromFarcasterTime(time);
  if (result.isErr()) throw result.error;
  return new Date(result.value);
}

/**
 * Helper function to convert byte arrays to text strings
 */
function bytesToText(bytes) {
  if (bytes === undefined) return undefined;
  if (bytes === null) return null;
  return Buffer.from(bytes).toString("utf-8");
}

/**
 * Helper function to sleep for a specified number of milliseconds
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Example replicator that processes external messages and creates cast objects
 */
class ExampleReplicator {
  constructor() {
    console.log("Example replicator initialized");
    this.isRunning = false;
    this.lastProcessedTimestamp = Date.now();
  }

  /**
   * Process an external message in raw hex format
   * @param {string} rawMessageHex - Raw message in hex format (with 0x prefix)
   * @param {Object} overrides - Optional overrides for message processing
   * @returns {Promise<Object>} - Result of processing
   */
  async processExternalMessage(rawMessageHex, overrides = {}) {
    try {
      // Check format and remove 0x prefix if present
      if (!rawMessageHex.startsWith("0x")) {
        throw new Error("Raw message must start with 0x");
      }

      const messageBytes = Buffer.from(rawMessageHex.slice(2), "hex");

      // Decode the message
      const messageObject = Message.decode(messageBytes);

      // Store the raw message for future reference
      await this.storeRawMessage(messageObject, rawMessageHex, overrides);

      // Process based on message type
      if (isCastAddMessage(messageObject)) {
        return await this.processCastAdd(messageObject, true, overrides);
      } else {
        console.log(`Unsupported message type: ${messageObject.data.type}`);
        return { success: false, error: "Unsupported message type" };
      }
    } catch (error) {
      console.error(`Error processing external message: ${error}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Store raw message in Messages collection for future reference
   */
  async storeRawMessage(messageObject, rawMessageHex, overrides = {}) {
    const hash = bytesToHex(messageObject.hash);

    // Check if message already exists
    const existingMessage = await Messages.findOne({ hash });
    if (existingMessage) {
      console.log(`Message ${hash} already exists, skipping storage`);
      return;
    }

    // Store the message with external flag
    await Messages.create({
      hash,
      timestamp: farcasterTimeToDate(messageObject.data.timestamp),
      raw: rawMessageHex,
      fid: messageObject.data.fid,
      external: true,
      unindexed: false,
      bodyOverrides: overrides,
    });

    console.log(`Stored raw message with hash ${hash}`);
  }

  /**
   * Process a cast add message
   * @param {Object} message - The cast message
   * @param {boolean} external - Whether this is an external message
   * @param {Object} overrides - Optional overrides for message processing
   * @returns {Promise<Object>} - The created cast
   */
  async processCastAdd(message, external = false, overrides = {}) {
    try {
      // Extract parent info from message or overrides
      const parentFid =
        overrides.parentCastId?.fid ||
        message.data.castAddBody.parentCastId?.fid;
      const parentHash = bytesToHex(
        message.data.castAddBody.parentCastId?.hash
      );

      // Process embeds
      const embeds = JSON.stringify(
        message.data.castAddBody.embeds ||
          message.data.castAddBody.embedsDeprecated?.map((x) => ({
            url: x,
          })) ||
          []
      );

      // Create the cast entry
      const castEntry = {
        timestamp: farcasterTimeToDate(message.data.timestamp),
        fid: message.data.fid,
        text: message.data.castAddBody.text || "",
        hash: bytesToHex(message.hash),
        parentHash,
        parentFid,
        parentUrl: message.data.castAddBody.parentUrl,
        embeds,
        mentions: message.data.castAddBody.mentions,
        mentionsPositions: message.data.castAddBody.mentionsPositions,
        threadHash: null, // Will be set later
        external,
      };

      // Check if cast already exists
      const existingCast = await Casts.findOne({
        hash: castEntry.hash,
      });

      if (existingCast) {
        console.log(`Cast ${castEntry.hash} already exists, skipping creation`);
        return { success: true, cast: existingCast };
      }

      // Create new cast
      const newCast = new Casts(castEntry);

      // Determine thread hash (simplified version)
      newCast.threadHash = parentHash || castEntry.hash;

      // Save the cast
      await newCast.save();

      console.log(`Created cast with hash ${newCast.hash}`);
      return { success: true, cast: newCast };
    } catch (error) {
      console.error(`Error processing cast add: ${error}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check for new unprocessed messages
   * @returns {Promise<Array>} - Array of processed message results
   */
  async checkForNewMessages() {
    try {
      // Find unprocessed messages newer than the last processed timestamp
      const unprocessedMessages = await Messages.find({
        unindexed: true,
        timestamp: { $gt: new Date(this.lastProcessedTimestamp) },
      }).limit(10);

      if (unprocessedMessages.length > 0) {
        console.log(
          `Found ${unprocessedMessages.length} new messages to process`
        );

        // Process each message and collect results
        const results = await Promise.all(
          unprocessedMessages.map(async (message) => {
            // Mark as processed
            await Messages.updateOne(
              { _id: message._id },
              { $set: { unindexed: false } }
            );

            // Process the message if it has raw data
            if (message.raw) {
              const messageObject = Message.decode(
                Buffer.from(message.raw.slice(2), "hex")
              );

              // If external message, set FID from the message
              if (message.external) {
                messageObject.data.fid = message.fid;
              }

              // Process based on message type
              if (isCastAddMessage(messageObject)) {
                return await this.processCastAdd(
                  messageObject,
                  message.external,
                  message.bodyOverrides || {}
                );
              } else {
                console.log(`Skipping unsupported message type`);
                return { success: false, message: "Unsupported message type" };
              }
            }

            return { success: false, message: "No raw data in message" };
          })
        );

        // Update last processed timestamp
        this.lastProcessedTimestamp = Date.now();

        return results;
      } else {
        // No new messages
        return [];
      }
    } catch (error) {
      console.error(`Error checking for new messages: ${error}`);
      return [{ success: false, error: error.message }];
    }
  }

  /**
   * Start the replicator processing loop
   */
  async start() {
    if (this.isRunning) {
      console.log("Replicator is already running");
      return;
    }

    this.isRunning = true;
    console.log("Starting example replicator loop");

    // Main processing loop
    while (this.isRunning) {
      try {
        // Check for and process new messages
        await this.checkForNewMessages();

        // Sleep for 200ms before next check
        await sleep(200);
      } catch (error) {
        console.error(`Error in replicator loop: ${error}`);
        // Continue the loop even after errors
      }
    }
  }

  /**
   * Stop the replicator processing loop
   */
  stop() {
    console.log("Stopping example replicator");
    this.isRunning = false;
  }
}

/**
 * Main function to run the example replicator
 */
async function main() {
  try {
    console.log("Starting example replicator...");

    // Create a new replicator instance
    const replicator = new ExampleReplicator();

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log("Received SIGINT. Shutting down gracefully...");
      replicator.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("Received SIGTERM. Shutting down gracefully...");
      replicator.stop();
      process.exit(0);
    });

    // Start the replicator loop
    await replicator.start();
  } catch (error) {
    console.error(`Fatal error: ${error}`);
    process.exit(1);
  }
}

// Run the main function when this script is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error(`Unhandled error in main: ${error}`);
    process.exit(1);
  });
}

module.exports = ExampleReplicator;
