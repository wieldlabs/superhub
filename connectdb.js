const mongoose = require("mongoose");

module.exports = {
  connectDB: () => {
    if (!process.env.MONGO_URL) {
      throw new Error("MONGO_URL env var not set");
    }
    return new Promise((resolve, reject) => {
      if (
        mongoose.connection.readyState == mongoose.ConnectionStates.connected
      ) {
        return resolve();
      }
      mongoose.set("strictQuery", true);
      mongoose
        .connect(process.env.MONGO_URL, {
          readPreference: "primary",
          compressors: ["zstd"],
          minPoolSize: 50,
          maxPoolSize: 250,
        })
        .then(() => {
          console.log("Mongoose up!");
          resolve();
        })
        .catch((e) => {
          console.log("Something went wrong with mongo:", e);
          reject(e);
        });
    });
  },
  mongoose,
};
