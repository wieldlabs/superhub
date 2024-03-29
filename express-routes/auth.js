const app = require("express").Router(), Sentry = require("@sentry/node"), _AuthService = require("../services/AuthService")["Service"], _AccountRecovererService = require("../services/AccountRecovererService")["Service"], {
  heavyLimiter,
  authContext,
  limiter
} = require("../helpers/express-middleware"), AccountInvite = require("../models/AccountInvite")["AccountInvite"];

app.post("/v1/auth-by-signature", heavyLimiter, async (e, s) => {
  e = e.body;
  try {
    var {
      account: r,
      accessToken: c
    } = await new _AuthService().authenticate(e);
    s.status(201).json({
      code: "201",
      success: !0,
      message: "Successfully authenticated",
      account: r,
      accessToken: c
    });
  } catch (e) {
    Sentry.captureException(e), console.error(e), s.status(500).json({
      code: "500",
      success: !1,
      message: e.message
    });
  }
}), app.get("/v1/get-account-signin-message", heavyLimiter, async (e, s) => {
  var {
    address: e,
    chainId: r = 1,
    creationOrigin: c
  } = e.query;
  if (!e) return s.json({
    code: 500,
    success: !1,
    message: "Address is required"
  });
  try {
    var t = await new _AuthService().getMessageToSign({
      address: e,
      chainId: r,
      creationOrigin: c
    });
    s.status(201).json({
      code: "201",
      success: !0,
      message: "Success",
      signature: t
    });
  } catch (e) {
    Sentry.captureException(e), console.error(e), s.status(500).json({
      code: "500",
      success: !1,
      message: e.message
    });
  }
}), app.get("/v1/get-current-account", [ limiter, authContext ], async (e, s) => {
  try {
    var r = e.context.account;
    if (!r) throw new Error("Account not found");
    var [ , c ] = await Promise.all([ await r.populate("addresses profileImage"), await AccountInvite.findOrCreate({
      accountId: r._id
    }) ]);
    s.status(201).json({
      code: "201",
      success: !0,
      message: "Success",
      account: {
        ...r.toObject(),
        invite: c
      }
    });
  } catch (e) {
    Sentry.captureException(e), console.error(e), s.status(500).json({
      code: "500",
      success: !1,
      message: e.message
    });
  }
}), app.post("/v1/add-recoverer", [ limiter, authContext ], async (e, s) => {
  var r = e.context.account;
  if (!r) throw new Error("Account not found");
  e = e.body.recovererAddress;
  if (!e) throw new Error("RecovererAddress is required");
  await r.populate("addresses");
  try {
    var c = await new _AccountRecovererService().addRecoverer(r, {
      id: r.addresses[0].address,
      type: "FARCASTER_SIGNER_EXTERNAL",
      address: e
    });
    s.status(201).json({
      code: "201",
      success: !0,
      message: "Recoverer added successfully",
      result: c
    });
  } catch (e) {
    Sentry.captureException(e), console.error(e), s.status(500).json({
      code: "500",
      success: !1,
      message: e.message
    });
  }
}), module.exports = {
  router: app
};