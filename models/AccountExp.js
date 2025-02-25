const mongoose = require("mongoose");
// https://mongoosejs.com/docs/advanced_schemas.html

const { schema } = require("../schemas/accountExp");

class AccountExpClass {
  static ping() {
    console.log("model: AccountExpClass");
  }
}

schema.loadClass(AccountExpClass);

const AccountExp =
  mongoose.models.AccountExp || mongoose.model("AccountExp", schema);

module.exports = {
  AccountExp,
};
