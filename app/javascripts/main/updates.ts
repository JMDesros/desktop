import compareVersions from 'compare-versions';
import { BrowserWindow, dialog, shell } from 'electron';
import electronLog from 'electron-log';
import { autoUpdater } from 'electron-updater';
import {
  action,
  autorun,
  computed,
  makeObservable,
  observable,
  transaction,
} from 'mobx';
import { MessageType } from '../../../test/TestIpcMessage';
import { AppState } from '../../application';
import { StoreKeys } from './store';
import { updates as str } from './strings';
import { handle } from './testing';
import { isTesting } from './utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logError(...message: any) {
  console.error('updateManager:', ...message);
}

if (isTesting()) {
  // eslint-disable-next-line no-var
  var notifiedStateUpdate = false;
}

export class UpdateState {
  latestVersion: string | null = null;
  enableAutoUpdate: boolean;
  checkingForUpdate = false;
  autoUpdateDownloaded = false;
  lastCheck: Date | null = null;

  constructor(private appState: AppState) {
    this.enableAutoUpdate = appState.store.get(StoreKeys.EnableAutoUpdate);
    makeObservable(this, {
      latestVersion: observable,
      enableAutoUpdate: observable,
      checkingForUpdate: observable,
      autoUpdateDownloaded: observable,
      lastCheck: observable,

      updateNeeded: computed,
      updatingIsSafe: computed,

      toggleAutoUpdate: action,
      setCheckingForUpdate: action,
      autoUpdateHasBeenDownloaded: action,
      setLatestVersion: action,
      checkedForUpdate: action,
    });
    if (isTesting()) {
      handle(MessageType.UpdateState, () => ({
        lastCheck: this.lastCheck,
      }));
    }
  }

  get updateNeeded(): boolean {
    if (this.latestVersion) {
      return compareVersions(this.appState.version, this.latestVersion) === 1;
    } else {
      return false;
    }
  }

  get updatingIsSafe(): boolean {
    return (
      !this.enableAutoUpdate &&
      !!this.appState.lastBackupDate &&
      isLessThanOneHourFromNow(this.appState.lastBackupDate)
    );
  }

  toggleAutoUpdate(): void {
    this.enableAutoUpdate = !this.enableAutoUpdate;
    this.appState.store.set(StoreKeys.EnableAutoUpdate, this.enableAutoUpdate);
  }

  setCheckingForUpdate(checking: boolean): void {
    this.checkingForUpdate = checking;
  }

  autoUpdateHasBeenDownloaded(): void {
    this.autoUpdateDownloaded = true;
  }

  setLatestVersion(version: string): void {
    this.latestVersion = version;
  }

  checkedForUpdate(): void {
    this.lastCheck = new Date();
  }
}

let updatesSetup = false;

export function setupUpdates(window: BrowserWindow, appState: AppState): void {
  if (updatesSetup) {
    throw Error('Already set up updates.');
  }
  const { store } = appState;

  autoUpdater.logger = electronLog;

  const updateState = appState.updates;
  function checkUpdateSafety() {
    const isSafeToUpdate = updateState.updatingIsSafe;
    autoUpdater.autoInstallOnAppQuit = isSafeToUpdate;
    autoUpdater.autoDownload = isSafeToUpdate;
  }
  autorun(checkUpdateSafety);
  const oneHour = 1 * 60 * 60 * 1000;
  setInterval(checkUpdateSafety, oneHour);

  autoUpdater.on('update-downloaded', (info: { version?: string }) => {
    window.webContents.send('update-available', null);
    transaction(() => {
      if (info.version) {
        updateState.setLatestVersion(info.version);
      }
      updateState.autoUpdateHasBeenDownloaded();
    });
  });

  autoUpdater.on('error', logError);
  autoUpdater.on('update-available', (info: { version?: string }) => {
    transaction(() => {
      if (info.version) {
        updateState.setLatestVersion(info.version);
      }
      updateState.checkedForUpdate();
    });
  });
  autoUpdater.on('update-not-available', (info: { version: string }) => {
    transaction(() => {
      updateState.setLatestVersion(info.version);
      updateState.checkedForUpdate();
    });
  });

  updatesSetup = true;

  if (isTesting()) {
    handle(MessageType.AutoUpdateEnabled, () =>
      store.get(StoreKeys.EnableAutoUpdate)
    );
    handle(MessageType.CheckForUpdate, () =>
      checkForUpdate(appState, updateState)
    );
    handle(
      MessageType.UpdateManagerNotifiedStateChange,
      () => notifiedStateUpdate
    );
  } else {
    checkForUpdate(appState, updateState);
  }
}

export function openChangelog(state: UpdateState): void {
  const url = 'https://github.com/standardnotes/desktop/releases';
  if (state.latestVersion) {
    shell.openExternal(`${url}/tag/v${state.latestVersion}`);
  } else {
    shell.openExternal(url);
  }
}

function quitAndInstall(window: BrowserWindow) {
  setTimeout(() => {
    // index.js prevents close event on some platforms
    window.removeAllListeners('close');
    window.close();
    autoUpdater.quitAndInstall(false);
  }, 0);
}

function isLessThanOneHourFromNow(date: number) {
  const now = Date.now();
  const onHourMs = 1 * 60 * 60 * 1000;
  return now - date < onHourMs;
}

export async function showUpdateInstallationDialog(
  parentWindow: BrowserWindow,
  appState: AppState
): Promise<void> {
  if (!appState.updates.latestVersion) return;
  if (
    appState.lastBackupDate &&
    isLessThanOneHourFromNow(appState.lastBackupDate)
  ) {
    const result = await dialog.showMessageBox(parentWindow, {
      type: 'info',
      title: str().updateReady.title,
      message: str().updateReady.message(appState.updates.latestVersion),
      buttons: [
        str().updateReady.installLater,
        str().updateReady.installAndRestart,
      ],
      cancelId: 0,
    });

    const buttonIndex = result.response;
    if (buttonIndex === 1) {
      quitAndInstall(parentWindow);
    }
  } else {
    const cancelId = 0;
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: str().updateReady.title,
      message: str().updateReady.noRecentBackupMessage,
      detail: str().updateReady.noRecentBackupDetail(appState.lastBackupDate),
      checkboxLabel: str().updateReady.noRecentBackupChecbox,
      checkboxChecked: false,
      buttons: [
        str().updateReady.installLater,
        str().updateReady.installAndRestart,
      ],
      cancelId,
    });

    if (!result.checkboxChecked || result.response === cancelId) {
      return;
    }
    quitAndInstall(parentWindow);
  }
}

export async function checkForUpdate(
  appState: AppState,
  state: UpdateState,
  userTriggered = false
): Promise<void> {
  if (state.enableAutoUpdate || userTriggered) {
    state.setCheckingForUpdate(true);
    try {
      const { updateInfo } = await autoUpdater.checkForUpdates();
      transaction(() => {
        state.checkedForUpdate();
        state.setLatestVersion(updateInfo.version);
      });

      if (userTriggered) {
        let message;
        if (state.updateNeeded && state.latestVersion) {
          message = str().finishedChecking.updateAvailable(state.latestVersion);
        } else {
          message = str().finishedChecking.noUpdateAvailable(appState.version);
        }

        dialog.showMessageBox({
          title: str().finishedChecking.title,
          message,
        });
      }
    } catch (error) {
      logError('Exception caught while checking for autoupdates:', error);
      if (userTriggered) {
        dialog.showMessageBox({
          title: str().finishedChecking.title,
          message: str().finishedChecking.error(JSON.stringify(error)),
        });
      }
    } finally {
      state.setCheckingForUpdate(false);
    }
  }
}