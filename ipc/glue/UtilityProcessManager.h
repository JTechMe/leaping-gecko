/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef _include_ipc_glue_UtilityProcessManager_h_
#define _include_ipc_glue_UtilityProcessManager_h_
#include "mozilla/MozPromise.h"
#include "mozilla/ipc/UtilityProcessHost.h"
#include "mozilla/EnumeratedArray.h"
#include "nsIObserver.h"
#include "nsTArray.h"

namespace mozilla {

class MemoryReportingProcess;

namespace ipc {

class UtilityProcessParent;

// The UtilityProcessManager is a singleton responsible for creating
// Utility-bound objects that may live in another process. Currently, it
// provides access to the Utility process via ContentParent.
class UtilityProcessManager final : public UtilityProcessHost::Listener {
  friend class UtilityProcessParent;

 public:
  static void Initialize();
  static void Shutdown();

  static RefPtr<UtilityProcessManager> GetSingleton();

  static RefPtr<UtilityProcessManager> GetIfExists();

  // Launch a new Utility process asynchronously
  RefPtr<GenericNonExclusivePromise> LaunchProcess(SandboxingKind aSandbox);

  void OnProcessUnexpectedShutdown(UtilityProcessHost* aHost);

  // Returns the platform pid for this utility sandbox process.
  Maybe<base::ProcessId> ProcessPid(SandboxingKind aSandbox);

  // Create a MemoryReportingProcess object for this utility process
  RefPtr<MemoryReportingProcess> GetProcessMemoryReporter(
      UtilityProcessParent* parent);

  // Returns access to the PUtility protocol if a Utility process for that
  // sandbox is present.
  RefPtr<UtilityProcessParent> GetProcessParent(SandboxingKind aSandbox) {
    RefPtr<ProcessFields> p = GetProcess(aSandbox);
    if (!p) {
      return nullptr;
    }
    return p->mProcessParent;
  }

  // Get a list of all valid utility process parent references
  nsTArray<RefPtr<UtilityProcessParent>> GetAllProcessesProcessParent() {
    nsTArray<RefPtr<UtilityProcessParent>> rv;
    for (auto& p : mProcesses) {
      if (p && p->mProcessParent) {
        rv.AppendElement(p->mProcessParent);
      }
    }
    return rv;
  }

  // Returns the Utility Process for that sandbox
  UtilityProcessHost* Process(SandboxingKind aSandbox) {
    RefPtr<ProcessFields> p = GetProcess(aSandbox);
    if (!p) {
      return nullptr;
    }
    return p->mProcess;
  }

  // Shutdown the Utility process for that sandbox.
  void CleanShutdown(SandboxingKind aSandbox);

  // Shutdown all utility processes
  void CleanShutdownAllProcesses();

 private:
  ~UtilityProcessManager();

  bool IsProcessLaunching(SandboxingKind aSandbox);
  bool IsProcessDestroyed(SandboxingKind aSandbox);

  // Called from our xpcom-shutdown observer.
  void OnXPCOMShutdown();
  void OnPreferenceChange(const char16_t* aData);

  UtilityProcessManager();

  void DestroyProcess(SandboxingKind aSandbox);

  bool IsShutdown() const;

  class Observer final : public nsIObserver {
   public:
    NS_DECL_ISUPPORTS
    NS_DECL_NSIOBSERVER
    explicit Observer(RefPtr<UtilityProcessManager> aManager);

   protected:
    ~Observer() = default;

    RefPtr<UtilityProcessManager> mManager;
  };
  friend class Observer;

  RefPtr<Observer> mObserver;

  class ProcessFields final {
   public:
    NS_INLINE_DECL_THREADSAFE_REFCOUNTING(ProcessFields);

    explicit ProcessFields(SandboxingKind aSandbox) : mSandbox(aSandbox){};

    // Promise will be resolved when this Utility process has been fully started
    // and configured. Only accessed on the main thread.
    RefPtr<GenericNonExclusivePromise> mLaunchPromise;

    uint32_t mNumProcessAttempts = 0;
    uint32_t mNumUnexpectedCrashes = 0;

    // Fields that are associated with the current Utility process.
    UtilityProcessHost* mProcess = nullptr;
    RefPtr<UtilityProcessParent> mProcessParent = nullptr;

    // Collects any pref changes that occur during process launch (after
    // the initial map is passed in command-line arguments) to be sent
    // when the process can receive IPC messages.
    nsTArray<dom::Pref> mQueuedPrefs;

    SandboxingKind mSandbox = SandboxingKind::COUNT;

   protected:
    ~ProcessFields() = default;
  };

  EnumeratedArray<SandboxingKind, SandboxingKind::COUNT, RefPtr<ProcessFields>>
      mProcesses;

  RefPtr<ProcessFields> GetProcess(SandboxingKind);
  bool NoMoreProcesses();
  uint16_t AliveProcesses();
};

}  // namespace ipc

}  // namespace mozilla

#endif  // _include_ipc_glue_UtilityProcessManager_h_
