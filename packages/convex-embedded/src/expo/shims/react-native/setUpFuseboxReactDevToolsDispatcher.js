class EventScope {
  #listeners = new Set();

  addEventListener(listener) {
    this.#listeners.add(listener);
  }

  removeEventListener(listener) {
    this.#listeners.delete(listener);
  }

  emit(value) {
    for (const listener of this.#listeners) {
      listener(value);
    }
  }
}

class Domain {
  constructor(name) {
    if (global[FuseboxReactDevToolsDispatcher.BINDING_NAME] == null) {
      throw new Error(
        `Could not create domain ${name}: receiving end doesn't exist`,
      );
    }

    this.name = name;
    this.onMessage = new EventScope();
  }

  sendMessage(message) {
    const messageWithDomain = { domain: this.name, message };
    global[FuseboxReactDevToolsDispatcher.BINDING_NAME](
      JSON.stringify(messageWithDomain),
    );
  }
}

class FuseboxReactDevToolsDispatcher {
  static #domainNameToDomainMap = new Map();
  static BINDING_NAME = "__CHROME_DEVTOOLS_FRONTEND_BINDING__";
  static onDomainInitialization = new EventScope();

  static initializeDomain(domainName) {
    const domain = new Domain(domainName);
    this.#domainNameToDomainMap.set(domainName, domain);
    this.onDomainInitialization.emit(domain);
    return domain;
  }

  static sendMessage(domainName, message) {
    const domain = this.#domainNameToDomainMap.get(domainName);
    if (domain == null) {
      throw new Error(
        `Could not send message to ${domainName}: domain doesn't exist`,
      );
    }

    try {
      domain.onMessage.emit(JSON.parse(message));
    } catch (err) {
      console.error(
        `Error while trying to send a message to domain ${domainName}:`,
        err,
      );
    }
  }
}

if (global.__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__ == null) {
  Object.defineProperty(global, "__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__", {
    value: FuseboxReactDevToolsDispatcher,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

module.exports = { Domain };
module.exports.default = { Domain };
