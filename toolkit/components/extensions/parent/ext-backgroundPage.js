/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { ExtensionParent } = ChromeUtils.import(
  "resource://gre/modules/ExtensionParent.jsm"
);
var {
  HiddenExtensionPage,
  promiseExtensionViewLoaded,
  watchExtensionWorkerContextLoaded,
} = ExtensionParent;

ChromeUtils.defineModuleGetter(
  this,
  "ExtensionTelemetry",
  "resource://gre/modules/ExtensionTelemetry.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "PrivateBrowsingUtils",
  "resource://gre/modules/PrivateBrowsingUtils.jsm"
);

XPCOMUtils.defineLazyGetter(this, "serviceWorkerManager", () => {
  return Cc["@mozilla.org/serviceworkers/manager;1"].getService(
    Ci.nsIServiceWorkerManager
  );
});

XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "backgroundIdleTimeout",
  "extensions.background.idle.timeout",
  30000,
  null,
  // Minimum 100ms, max 5min
  delay => Math.min(Math.max(delay, 100), 5 * 60 * 1000)
);

function notifyBackgroundScriptStatus(addonId, isRunning) {
  // Notify devtools when the background scripts is started or stopped
  // (used to show the current status in about:debugging).
  const subject = { addonId, isRunning };
  Services.obs.notifyObservers(subject, "extension:background-script-status");
}

/**
 * Background Page state transitions:
 *
 *    ------> STOPPED <-------
 *    |         |            |
 *    |         v            |
 *    |      STARTING >------|
 *    |         |            |
 *    |         v            ^
 *    |----< RUNNING ----> SUSPENDING
 *              ^            v
 *              |------------|
 *
 * STARTING:   The background is being built.
 * RUNNING:    The background is running.
 * SUSPENDING: The background is suspending, runtime.onSuspend will be called.
 * STOPPED:    The background is not running.
 *
 * For persistent backgrounds, the SUSPENDING is not used.
 */
const BACKGROUND_STATE = {
  STARTING: "starting",
  RUNNING: "running",
  SUSPENDING: "suspending",
  STOPPED: "stopped",
};

// Responsible for the background_page section of the manifest.
class BackgroundPage extends HiddenExtensionPage {
  constructor(extension, options) {
    super(extension, "background");

    this.page = options.page || null;
    this.isGenerated = !!options.scripts;

    if (this.page) {
      this.url = this.extension.baseURI.resolve(this.page);
    } else if (this.isGenerated) {
      this.url = this.extension.baseURI.resolve(
        "_generated_background_page.html"
      );
    }
  }

  async build() {
    const { extension } = this;
    ExtensionTelemetry.backgroundPageLoad.stopwatchStart(extension, this);

    let context;
    try {
      await this.createBrowserElement();
      if (!this.browser) {
        throw new Error(
          "Extension shut down before the background page was created"
        );
      }
      extension._backgroundPageFrameLoader = this.browser.frameLoader;

      extensions.emit("extension-browser-inserted", this.browser);

      let contextPromise = promiseExtensionViewLoaded(this.browser);
      this.browser.loadURI(this.url, {
        triggeringPrincipal: extension.principal,
      });

      context = await contextPromise;
      ExtensionTelemetry.backgroundPageLoad.stopwatchFinish(extension, this);
    } catch (e) {
      // Extension was down before the background page has loaded.
      ExtensionTelemetry.backgroundPageLoad.stopwatchCancel(extension, this);
      throw e;
    }

    return context;
  }

  shutdown() {
    this.extension._backgroundPageFrameLoader = null;
    super.shutdown();
  }
}

// Responsible for the background.service_worker section of the manifest.
class BackgroundWorker {
  constructor(extension, options) {
    this.extension = extension;
    this.workerScript = options.service_worker;

    if (!this.workerScript) {
      throw new Error("Missing mandatory background.service_worker property");
    }
  }

  get registrationInfo() {
    const { principal } = this.extension;
    return serviceWorkerManager.getRegistrationForAddonPrincipal(principal);
  }

  getWorkerInfo(descriptorId) {
    return this.registrationInfo?.getWorkerByID(descriptorId);
  }

  validateWorkerInfoForContext(context) {
    const { extension } = this;
    if (!this.getWorkerInfo(context.workerDescriptorId)) {
      throw new Error(
        `ServiceWorkerInfo not found for ${extension.policy.debugName} contextId ${context.contextId}`
      );
    }
  }

  async build() {
    const { extension } = this;
    let context;
    const contextPromise = new Promise(resolve => {
      let unwatch = watchExtensionWorkerContextLoaded(
        { extension, viewType: "background_worker" },
        context => {
          unwatch();
          this.validateWorkerInfoForContext(context);
          resolve(context);
        }
      );
    });

    // TODO(Bug 17228327): follow up to spawn the active worker for a previously installed
    // background service worker.
    await serviceWorkerManager.registerForAddonPrincipal(
      this.extension.principal
    );

    context = await contextPromise;

    await this.waitForActiveWorker();
    return context;
  }

  shutdown(isAppShutdown) {
    // All service worker registrations related to the extensions will be unregistered
    // - when the extension is shutting down if the application is not also shutting down
    //   shutdown (in which case a previously registered service worker is expected to stay
    //   active across browser restarts).
    // - when the extension has been uninstalled
    if (!isAppShutdown) {
      this.registrationInfo?.forceShutdown();
    }
  }

  waitForActiveWorker() {
    const { extension, registrationInfo } = this;
    return new Promise((resolve, reject) => {
      const resolveOnActive = () => {
        if (
          registrationInfo.activeWorker?.state ===
          Ci.nsIServiceWorkerInfo.STATE_ACTIVATED
        ) {
          resolve();
          return true;
        }
        return false;
      };

      const rejectOnUnregistered = () => {
        if (registrationInfo.unregistered) {
          reject(
            new Error(
              `Background service worker unregistered for "${extension.policy.debugName}"`
            )
          );
          return true;
        }
        return false;
      };

      if (resolveOnActive() || rejectOnUnregistered()) {
        return;
      }

      const listener = {
        onChange() {
          if (resolveOnActive() || rejectOnUnregistered()) {
            registrationInfo.removeListener(listener);
          }
        },
      };
      registrationInfo.addListener(listener);
    });
  }
}

this.backgroundPage = class extends ExtensionAPI {
  async build() {
    if (this.bgInstance) {
      return;
    }

    let { extension } = this;
    let { manifest } = extension;
    extension.backgroundState = BACKGROUND_STATE.STARTING;

    let BackgroundClass = manifest.background.service_worker
      ? BackgroundWorker
      : BackgroundPage;

    this.bgInstance = new BackgroundClass(extension, manifest.background);
    let context;
    try {
      context = await this.bgInstance.build();
      // Top level execution already happened, RUNNING is
      // a touch after the fact.
      if (context && this.extension) {
        extension.backgroundState = BACKGROUND_STATE.RUNNING;
      }
    } catch (e) {
      Cu.reportError(e);
      if (extension.persistentListeners) {
        // Clear the primed listeners, but leave them persisted.
        EventManager.clearPrimedListeners(extension, false);
      }
      extension.backgroundState = BACKGROUND_STATE.STOPPED;
      extension.emit("background-script-aborted");
      return;
    }

    if (context) {
      // Wait until all event listeners registered by the script so far
      // to be handled. We then set listenerPromises to null, which indicates
      // to addListener that the background script has finished loading.
      await Promise.all(context.listenerPromises);
      context.listenerPromises = null;
    }

    if (extension.persistentListeners) {
      // |this.extension| may be null if the extension was shut down.
      // In that case, we still want to clear the primed listeners,
      // but not update the persistent listeners in the startupData.
      EventManager.clearPrimedListeners(extension, !!this.extension);
    }

    if (!context || !this.extension) {
      extension.backgroundState = BACKGROUND_STATE.STOPPED;
      extension.emit("background-script-aborted");
      return;
    }
    if (!context.unloaded) {
      notifyBackgroundScriptStatus(extension.id, true);
      context.callOnClose({
        close() {
          notifyBackgroundScriptStatus(extension.id, false);
        },
      });
    }

    extension.emit("background-script-started");
  }

  observe(subject, topic, data) {
    if (topic == "timer-callback") {
      let { extension } = this;
      this.clearIdleTimer();
      extension?.terminateBackground();
    }
  }

  clearIdleTimer() {
    this.backgroundTimer?.cancel();
    this.backgroundTimer = null;
  }

  resetIdleTimer() {
    this.clearIdleTimer();
    let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.init(this, backgroundIdleTimeout, Ci.nsITimer.TYPE_ONE_SHOT);
    this.backgroundTimer = timer;
  }

  async primeBackground(isInStartup = true) {
    let { extension } = this;

    if (this.bgInstance) {
      Cu.reportError(`background script exists before priming ${extension.id}`);
    }
    this.bgInstance = null;

    // When in PPB background pages all run in a private context.  This check
    // simply avoids an extraneous error in the console since the BaseContext
    // will throw.
    if (
      PrivateBrowsingUtils.permanentPrivateBrowsing &&
      !extension.privateBrowsingAllowed
    ) {
      return;
    }

    // Used by runtime messaging to wait for background page listeners.
    let bgStartupPromise = new Promise(resolve => {
      let done = () => {
        extension.off("background-script-started", done);
        extension.off("background-script-aborted", done);
        extension.off("shutdown", done);
        resolve();
      };
      extension.on("background-script-started", done);
      extension.on("background-script-aborted", done);
      extension.on("shutdown", done);
    });

    extension.promiseBackgroundStarted = () => {
      return bgStartupPromise;
    };

    extension.wakeupBackground = () => {
      extension.emit("background-script-event");
      extension.wakeupBackground = () => bgStartupPromise;
      return bgStartupPromise;
    };

    let resetBackgroundIdle = () => {
      this.clearIdleTimer();
      if (!this.extension || extension.persistentBackground) {
        // Extension was already shut down or is persistent and
        // does not idle timout.
        return;
      }
      // TODO remove at an appropriate point in the future prior
      // to general availability.  There may be some racy conditions
      // with idle timeout between an event starting and the event firing
      // but we still want testing with an idle timeout.
      if (
        !Services.prefs.getBoolPref("extensions.background.idle.enabled", true)
      ) {
        return;
      }

      if (extension.backgroundState == BACKGROUND_STATE.SUSPENDING) {
        extension.backgroundState = BACKGROUND_STATE.RUNNING;
        // call runtime.onSuspendCanceled
        extension.emit("background-script-suspend-canceled");
      }
      this.resetIdleTimer();
    };

    // Listen for events from the EventManager
    extension.on("background-script-reset-idle", resetBackgroundIdle);
    // After the background is started, initiate the first timer
    extension.once("background-script-started", resetBackgroundIdle);

    extension.terminateBackground = async () => {
      await bgStartupPromise;
      if (!this.extension) {
        // Extension was already shut down.
        return;
      }
      if (extension.backgroundState != BACKGROUND_STATE.RUNNING) {
        return;
      }
      extension.backgroundState = BACKGROUND_STATE.SUSPENDING;
      this.clearIdleTimer();
      // call runtime.onSuspend
      await extension.emit("background-script-suspend");
      // If in the meantime another event fired, state will be RUNNING,
      // and if it was shutdown it will be STOPPED.
      if (extension.backgroundState != BACKGROUND_STATE.SUSPENDING) {
        return;
      }
      extension.off("background-script-reset-idle", resetBackgroundIdle);
      this.onShutdown(false);
      EventManager.clearPrimedListeners(this.extension, false);
      // Setup background startup listeners for next primed event.
      return this.primeBackground(false);
    };

    // Persistent backgrounds are started immediately except during APP_STARTUP.
    // Non-persistent backgrounds must be started immediately for new install or enable
    // to initialize the addon and create the persisted listeners.
    // updateReason is set when an extension is updated during APP_STARTUP.
    if (
      isInStartup &&
      (extension.testNoDelayedStartup ||
        extension.startupReason !== "APP_STARTUP" ||
        extension.updateReason)
    ) {
      return this.build();
    }

    EventManager.primeListeners(extension, isInStartup);

    extension.once("start-background-script", async () => {
      if (!this.extension) {
        // Extension was shut down. Don't build the background page.
        // Primed listeners have been cleared in onShutdown.
        return;
      }
      await this.build();
    });

    // There are two ways to start the background page:
    // 1. If a primed event fires, then start the background page as
    //    soon as we have painted a browser window.  Note that we have
    //    to touch browserPaintedPromise here to initialize the listener
    //    or else we can miss it if the event occurs after the first
    //    window is painted but before #2
    // 2. After all windows have been restored on startup (see onManifestEntry).
    extension.once("background-script-event", async () => {
      await ExtensionParent.browserPaintedPromise;
      extension.emit("start-background-script");
    });
  }

  onShutdown(isAppShutdown) {
    this.extension.backgroundState = BACKGROUND_STATE.STOPPED;
    // Ensure there is no backgroundTimer running
    this.clearIdleTimer();

    if (this.bgInstance) {
      this.bgInstance.shutdown(isAppShutdown);
      this.bgInstance = null;
      // Emit an event for tests.
      this.extension.emit("shutdown-background-script");
    } else {
      EventManager.clearPrimedListeners(this.extension, false);
    }
  }

  async onManifestEntry(entryName) {
    let { extension } = this;
    extension.backgroundState = BACKGROUND_STATE.STOPPED;

    // runtime.onStartup event support.  We listen for the first
    // background startup then emit a first-run event.
    extension.once("background-script-started", () => {
      extension.emit("background-first-run");
    });

    await this.primeBackground();

    ExtensionParent.browserStartupPromise.then(() => {
      // Return early if the background was created in the first
      // primeBackground call.  This happens for install, upgrade, downgrade.
      if (this.bgInstance) {
        return;
      }

      // If there are no listeners for the extension that were persisted, we need to
      // start the event page so they can be registered.
      if (
        extension.persistentBackground ||
        !extension.persistentListeners?.size ||
        // If runtime.onStartup has a listener and this is app_startup,
        // start the extension so it will fire the event.
        (extension.startupReason == "APP_STARTUP" &&
          extension.persistentListeners?.get("runtime").has("onStartup"))
      ) {
        extension.emit("start-background-script");
      } else {
        // During startup we only prime startup blocking listeners.  At
        // this stage we need to prime all listeners for event pages.
        EventManager.clearPrimedListeners(extension, false);
        // Allow re-priming by deleting existing listeners.
        extension.persistentListeners = null;
        EventManager.primeListeners(extension, false);
      }
    });
  }
};
