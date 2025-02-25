const express = require("express");

const { router: apiKeyRouter } = require("./express-routes/apikey");
const { router: farcasterRouter } = require("./express-routes/farcaster");

const { connectDB } = require("./connectdb");

const app = express();

app.use("/apikey", apiKeyRouter);
app.use("/farcaster", farcasterRouter);

app.listen(3000, async () => {
  await connectDB();
  console.log("Server is running on port 3000");
});
