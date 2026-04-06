const ExpoCrypto = require("expo-crypto");

const shim = {
  subtle: globalThis.crypto?.subtle,
  ensureSecure() {
    return Promise.resolve(true);
  },
  getRandomValues(array) {
    return ExpoCrypto.getRandomValues(array);
  },
};

module.exports = shim;
Object.defineProperty(module.exports, "__esModule", { value: true });
module.exports.default = shim;
