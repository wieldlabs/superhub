const express = require("express");
const dotenv = require("dotenv");

const { router: apiKeyRouter } = require("./express-routes/apikey");
const { router: farcasterRouter } = require("./express-routes/farcaster");

const { connectDB } = require("./connectdb");

// Load environment variables from .env file
dotenv.config();

// Check required environment variables
const REQUIRED_ENV_VARS = [
  "JWT_SECRET",
  "MONGO_URL",
  "MEMCACHED_URL",
  "NODE_ENV",
];

const missingVars = REQUIRED_ENV_VARS.filter((envVar) => {
  if (!process.env[envVar]) {
    console.error(`${envVar} is not set. Please set it (e.g. .env file)!`);
    return true;
  }
  return false;
});

if (missingVars.length > 0) {
  console.error("Exiting...");
  process.exit(1);
}

const app = express();

app.use("/apikey", apiKeyRouter);
app.use("/farcaster", farcasterRouter);

app.listen(3000, async () => {
  await connectDB();
  console.log("Server is running on port 3000");
});
