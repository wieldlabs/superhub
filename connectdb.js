const mongoose = require("mongoose");

module.exports = {
  connectDB: () => {
    if (process.env.MONGO_URL) return new Promise((o, e) => {
      if (mongoose.connection.readyState == mongoose.ConnectionStates.connected) return o();
      mongoose.set("strictQuery", !0), mongoose.connect(process.env.MONGO_URL, {
        readPreference: "primary",
        compressors: [ "zstd" ],
        minPoolSize: 50,
        maxPoolSize: 250
      }).then(() => {
        console.log("Mongoose up!"), o();
      }).catch(o => {
        console.log("Something went wrong with mongo:", o), e(o);
      });
    });
    throw new Error("MONGO_URL env var not set");
  },
  mongoose: mongoose
};