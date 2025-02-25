const mongoose = require("mongoose");
// https://mongoosejs.com/docs/advanced_schemas.html

const { schema } = require("../schemas/apiKey");

class ApiKeyClass {
  static ping() {
    console.log("model: ApiKeyClass");
  }
}

schema.loadClass(ApiKeyClass);

const ApiKey = mongoose.models.ApiKey || mongoose.model("ApiKey", schema);

module.exports = {
  ApiKey,
};
