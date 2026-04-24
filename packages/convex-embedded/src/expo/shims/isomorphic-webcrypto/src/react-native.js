require("react-native-get-random-values");

const shim = {
  subtle: globalThis.crypto?.subtle,
  ensureSecure() {
    return Promise.resolve(true);
  },
  getRandomValues(array) {
    return globalThis.crypto.getRandomValues(array);
  },
};

module.exports = shim;
Object.defineProperty(module.exports, "__esModule", { value: true });
module.exports.default = shim;
