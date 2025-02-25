const mongoose = require("mongoose");
// https://mongoosejs.com/docs/advanced_schemas.html

const { schema } = require("../schemas/accountAddress");

class AccountAddressClass {
  static ping() {
    console.log("model: AccountAddressClass");
  }
}

schema.loadClass(AccountAddressClass);

const AccountAddress =
  mongoose.models.AccountAddress || mongoose.model("AccountAddress", schema);

module.exports = {
  AccountAddress,
};
