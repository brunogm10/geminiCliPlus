/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  Box,
  DOMElement,
  measureElement,
  Static,
  Text,
  useStdin,
  useStdout,
  useInput,
  type Key as InkKeyType,
} from 'ink';
import { StreamingState, type HistoryItem, MessageType } from './types.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useGeminiStream } from './hooks/useGeminiStream.js';
import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { useThemeCommand } from './hooks/useThemeCommand.js';
import { useAuthCommand } from './hooks/useAuthCommand.js';
import { useEditorSettings } from './hooks/useEditorSettings.js';
import { useSlashCommandProcessor } from './hooks/slashCommandProcessor.js';
import { useAutoAcceptIndicator } from './hooks/useAutoAcceptIndicator.js';
import { useConsoleMessages } from './hooks/useConsoleMessages.js';
import { Header } from './components/Header.js';
import { LoadingIndicator } from './components/LoadingIndicator.js';
import { AutoAcceptIndicator } from './components/AutoAcceptIndicator.js';
import { ShellModeIndicator } from './components/ShellModeIndicator.js';
import { InputPrompt } from './components/InputPrompt.js';
import { Footer } from './components/Footer.js';
import { ThemeDialog } from './components/ThemeDialog.js';
import { AuthDialog } from './components/AuthDialog.js';
import { AuthInProgress } from './components/AuthInProgress.js';
import { EditorSettingsDialog } from './components/EditorSettingsDialog.js';
import { Colors } from './colors.js';
import { Help } from './components/Help.js';
import { loadHierarchicalGeminiMemory } from '../config/config.js';
import { LoadedSettings } from '../config/settings.js';
import { Tips } from './components/Tips.js';
import { ConsolePatcher } from './utils/ConsolePatcher.js';
import { registerCleanup } from '../utils/cleanup.js';
import { DetailedMessagesDisplay } from './components/DetailedMessagesDisplay.js';
import { HistoryItemDisplay } from './components/HistoryItemDisplay.js';
import { ContextSummaryDisplay } from './components/ContextSummaryDisplay.js';
import { useHistory } from './hooks/useHistoryManager.js';
import process from 'node:process';
import {
  getErrorMessage,
  type Config,
  getAllGeminiMdFilenames,
  ApprovalMode,
  isEditorAvailable,
  EditorType,
  FlashFallbackEvent,
  logFlashFallback,
  AuthType,
  type OpenFiles,
  ideContext,
} from '@google/gemini-cli-core';
import { validateAuthMethod } from '../config/auth.js';
import { useLogger } from './hooks/useLogger.js';
import { StreamingContext } from './contexts/StreamingContext.js';
import {
  SessionStatsProvider,
  useSessionStats,
} from './contexts/SessionContext.js';
import { useGitBranchName } from './hooks/useGitBranchName.js';
import { useFocus } from './hooks/useFocus.js';
import { useBracketedPaste } from './hooks/useBracketedPaste.js';
import { useTextBuffer } from './components/shared/text-buffer.js';
import * as fs from 'fs';
import { UpdateNotification } from './components/UpdateNotification.js';
import {
  isProQuotaExceededError,
  isGenericQuotaExceededError,
  UserTierId,
} from '@google/gemini-cli-core';
import { checkForUpdates, type UpdateInfo } from './utils/updateCheck.js';
import ansiEscapes from 'ansi-escapes';
import { OverflowProvider } from './contexts/OverflowContext.js';
import { ShowMoreLines } from './components/ShowMoreLines.js';
import { PrivacyNotice } from './privacy/PrivacyNotice.js';
import { usePromptCompletion } from './hooks/usePromptCompletion.js';
import { spawn } from 'node:child_process';
import { PasswordPrompt } from './components/PasswordPrompt.js';
import { PasswordRequester } from '../gemini.js';

const CTRL_EXIT_PROMPT_DURATION_MS = 1000;

interface AppProps {
  config: Config;
  settings: LoadedSettings;
  startupWarnings?: string[];
  version: string;
  passwordRequester: PasswordRequester;
}

function handleAutoUpdate(
  info: UpdateInfo | null,
  setUpdateInfo: (info: UpdateInfo | null) => void,
  setIsUpdating: (isUpdating: boolean) => void,
  addItem: (item: HistoryItem, timestamp: number) => void,
) {
  if (!info) {
    return;
  }

  setUpdateInfo(info);
  if (process.env.GEMINI_CLI_DISABLE_AUTOUPDATER === 'true') {
    setIsUpdating(false);
    return;
  }

  setIsUpdating(true);

  const updateProcess = spawn(
    `rm -rf $(npm root -g)/@google/gemini-cli && npm install -g @google/gemini-cli@${info.update.latest}`,
    { stdio: 'pipe', shell: true },
  );
  let errorOutput = '';
  updateProcess.stderr.on('data', (data) => {
    errorOutput += data.toString();
  });

  updateProcess.on('close', (code) => {
    if (code === 0) {
      addItem(
        {
          id: Date.now(),
          type: MessageType.INFO,
          text: `Update successful! The new version will be used on your next run.`,
        },
        Date.now(),
      );
    } else {
      addItem(
        {
          id: Date.now(),
          type: MessageType.ERROR,
          text: `Automatic update failed. Please try updating manually: npm i -g @google/gemini-cli@latest`,
        },
        Date.now(),
      );
      console.error(
        `Update process exited with code ${code}. Stderr: ${errorOutput}`,
      );
    }
    setIsUpdating(false);
    setUpdateInfo(null);
  });

  updateProcess.on('error', (err) => {
    addItem(
      {
        id: Date.now(),
        type: MessageType.ERROR,
        text: `Failed to start the update process: ${err.message}. Please ensure npm is installed and in your PATH.`,
      },
      Date.now(),
    );
    console.error('install error:', err);
    setIsUpdating(false);
    setUpdateInfo(null);
  });
}

export const AppWrapper = (props: AppProps) => (
  <SessionStatsProvider>
    <App {...props} />
  </SessionStatsProvider>
);

const App = ({ config, settings, startupWarnings = [], version, passwordRequester }: AppProps) => {
  const isFocused = useFocus();
  useBracketedPaste();
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const { stdout } = useStdout();
  const nightly = version.includes('nightly');
  const { history, addItem, clearItems, loadHistory } = useHistory();

  useEffect(() => {
    checkForUpdates().then((info) => {
      if (!info) {
        return;
      }

      if (settings.merged.disableAutoUpdate) {
        setUpdateInfo(info);
        setTimeout(() => {
          addItem(
            {
              type: MessageType.INFO,
              text: `${info?.message}\nRun npm install -g ${info?.update.name} to install`,
            },
            Date.now(),
          );
          setUpdateInfo(null);
        }, 60000);
        return;
      }

      handleAutoUpdate(info, setUpdateInfo, setIsUpdating, addItem);
    });
  }, [addItem, settings.merged.disableAutoUpdate]);

  const {
    consoleMessages,
    handleNewMessage,
    clearConsoleMessages: clearConsoleMessagesState,
  } = useConsoleMessages();

  useEffect(() => {
    const consolePatcher = new ConsolePatcher({
      onNewMessage: handleNewMessage,
      debugMode: config.getDebugMode(),
    });
    consolePatcher.patch();
    registerCleanup(consolePatcher.cleanup);
  }, [handleNewMessage, config]);

  const { stats: sessionStats } = useSessionStats();
  const [staticNeedsRefresh, setStaticNeedsRefresh] = useState(false);
  const [staticKey, setStaticKey] = useState(0);
  const refreshStatic = useCallback(() => {
    stdout.write(ansiEscapes.clearTerminal);
    setStaticKey((prev) => prev + 1);
  }, [setStaticKey, stdout]);

  const [geminiMdFileCount, setGeminiMdFileCount] = useState<number>(0);
  const [debugMessage, setDebugMessage] = useState<string>('');
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [footerHeight, setFooterHeight] = useState<number>(0);
  const [corgiMode, setCorgiMode] = useState(false);
  const [currentModel, setCurrentModel] = useState(config.getModel());
  const [shellModeActive, setShellModeActive] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState<boolean>(false);
  const [showToolDescriptions, setShowToolDescriptions] =
    useState<boolean>(false);
  const [ctrlCPressedOnce, setCtrlCPressedOnce] = useState(false);
  const [quittingMessages, setQuittingMessages] = useState<
    HistoryItem[] | null
  >(null);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [ctrlDPressedOnce, setCtrlDPressedOnce] = useState(false);
  const ctrlDTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [constrainHeight, setConstrainHeight] = useState<boolean>(true);
  const [showPrivacyNotice, setShowPrivacyNotice] = useState<boolean>(false);
  const [modelSwitchedFromQuotaError, setModelSwitchedFromQuotaError] =
    useState<boolean>(false);
  const [userTier, setUserTier] = useState<UserTierId | undefined>(undefined);
  const [showEscapePrompt, setShowEscapePrompt] = useState(false);
  const [clearBufferFn, setClearBufferFn] = useState<(() => void) | null>(null);
  const [openFiles, setOpenFiles] = useState<OpenFiles | undefined>();
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [passwordRequest, setPasswordRequest] = useState<{ prompt: string; resolve: (password: string | null) => void; } | null>(null);

  useEffect(() => {
    const unsubscribe = ideContext.subscribeToOpenFiles(setOpenFiles);
    // Set the initial value
    setOpenFiles(ideContext.getOpenFilesContext());
    return unsubscribe;
  }, []);

  useEffect(() => {
    passwordRequester.request = (prompt: string) => new Promise((resolve) => {
        setPasswordRequest({ prompt, resolve });
      });
  }, [passwordRequester, setPasswordRequest]);

  const openPrivacyNotice = useCallback(() => {
    setShowPrivacyNotice(true);
  }, []);

  const handleEscapePromptChange = useCallback((showPrompt: boolean) => {
    setShowEscapePrompt(showPrompt);
  }, []);

  const handleClearBuffer = useCallback((clearFn: () => void) => {
    setClearBufferFn(() => clearFn);
  }, []);

  const initialPromptSubmitted = useRef(false);

  const errorCount = useMemo(
    () => consoleMessages.filter((msg) => msg.type === 'error').length,
    [consoleMessages],
  );

  const {
    isThemeDialogOpen,
    openThemeDialog,
    handleThemeSelect,
    handleThemeHighlight,
  } = useThemeCommand(settings, setThemeError, addItem);

  const {
    isAuthDialogOpen,
    openAuthDialog,
    handleAuthSelect,
    isAuthenticating,
    cancelAuthentication,
  } = useAuthCommand(settings, setAuthError, config);

  useEffect(() => {
    if (settings.merged.selectedAuthType) {
      const error = validateAuthMethod(settings.merged.selectedAuthType);
      if (error) {
        setAuthError(error);
        openAuthDialog();
      }
    }
  }, [settings.merged.selectedAuthType, openAuthDialog, setAuthError]);

  // Sync user tier from config when authentication changes
  useEffect(() => {
    // Only sync when not currently authenticating
    if (!isAuthenticating) {
      setUserTier(config.getGeminiClient()?.getUserTier());
    }
  }, [config, isAuthenticating]);

  const {
    isEditorDialogOpen,
    openEditorDialog,
    handleEditorSelect,
    exitEditorDialog,
  } = useEditorSettings(settings, setEditorError, addItem);

  const toggleCorgiMode = useCallback(() => {
    setCorgiMode((prev) => !prev);
  }, []);

  const performMemoryRefresh = useCallback(async () => {
    addItem(
      {
        type: MessageType.INFO,
        text: 'Refreshing hierarchical memory (GEMINI.md or other context files)...',
      },
      Date.now(),
    );
    try {
      const { memoryContent, fileCount } = await loadHierarchicalGeminiMemory(
        process.cwd(),
        config.getDebugMode(),
        config.getFileService(),
        config.getExtensionContextFilePaths(),
        config.getFileFilteringOptions(),
      );

      config.setUserMemory(memoryContent);
      config.setGeminiMdFileCount(fileCount);
      setGeminiMdFileCount(fileCount);

      addItem(
        {
          type: MessageType.INFO,
          text: `Memory refreshed successfully. ${memoryContent.length > 0 ? `Loaded ${memoryContent.length} characters from ${fileCount} file(s).` : 'No memory content found.'}`,
        },
        Date.now(),
      );
      if (config.getDebugMode()) {
        console.log(
          `[DEBUG] Refreshed memory content in config: ${memoryContent.substring(0, 200)}...`,
        );
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      addItem(
        {
          type: MessageType.ERROR,
          text: `Error refreshing memory: ${errorMessage}`,
        },
        Date.now(),
      );
      console.error('Error refreshing memory:', error);
    }
  }, [config, addItem]);

  // Watch for model changes (e.g., from Flash fallback)
  useEffect(() => {
    const checkModelChange = () => {
      const configModel = config.getModel();
      if (configModel !== currentModel) {
        setCurrentModel(configModel);
      }
    };

    // Check immediately and then periodically
    checkModelChange();
    const interval = setInterval(checkModelChange, 1000); // Check every second

    return () => clearInterval(interval);
  }, [config, currentModel]);

  // Set up Flash fallback handler
  useEffect(() => {
    const flashFallbackHandler = async (
      currentModel: string,
      fallbackModel: string,
      error?: unknown,
    ): Promise<boolean> => {
      let message: string;

      if (
        config.getContentGeneratorConfig().authType ===
        AuthType.LOGIN_WITH_GOOGLE
      ) {
        // Use actual user tier if available; otherwise, default to FREE tier behavior (safe default)
        const isPaidTier =
          userTier === UserTierId.LEGACY || userTier === UserTierId.STANDARD;

        // Check if this is a Pro quota exceeded error
        if (error && isProQuotaExceededError(error)) {
          if (isPaidTier) {
            message = `⚡ You have reached your daily ${currentModel} quota limit.
⚡ Automatically switching from ${currentModel} to ${fallbackModel} for the remainder of this session.
⚡ To continue accessing the ${currentModel} model today, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey`;
          } else {
            message = `⚡ You have reached your daily ${currentModel} quota limit.
⚡ Automatically switching from ${currentModel} to ${fallbackModel} for the remainder of this session.
⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist
⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key
⚡ You can switch authentication methods by typing /auth`;
          }
        } else if (error && isGenericQuotaExceededError(error)) {
          if (isPaidTier) {
            message = `⚡ You have reached your daily quota limit.
⚡ Automatically switching from ${currentModel} to ${fallbackModel} for the remainder of this session.
⚡ To continue accessing the ${currentModel} model today, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey`;
          } else {
            message = `⚡ You have reached your daily quota limit.
⚡ Automatically switching from ${currentModel} to ${fallbackModel} for the remainder of this session.
⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist
⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key
⚡ You can switch authentication methods by typing /auth`;
          }
        } else {
          if (isPaidTier) {
            // Default fallback message for other cases (like consecutive 429s)
            message = `⚡ Automatically switching from ${currentModel} to ${fallbackModel} for faster responses for the remainder of this session.
⚡ Possible reasons for this are that you have received multiple consecutive capacity errors or you have reached your daily ${currentModel} quota limit
⚡ To continue accessing the ${currentModel} model today, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey`;
          } else {
            // Default fallback message for other cases (like consecutive 429s)
            message = `⚡ Automatically switching from ${currentModel} to ${fallbackModel} for faster responses for the remainder of this session.
⚡ Possible reasons for this are that you have received multiple consecutive capacity errors or you have reached your daily ${currentModel} quota limit
⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist
⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key
⚡ You can switch authentication methods by typing /auth`;
          }
        }

        // Add message to UI history
        addItem(
          {
            type: MessageType.INFO,
            text: message,
          },
          Date.now(),
        );

        // Set the flag to prevent tool continuation
        setModelSwitchedFromQuotaError(true);
        // Set global quota error flag to prevent Flash model calls
        config.setQuotaErrorOccurred(true);
      }

      // Switch model for future use but return false to stop current retry
      config.setModel(fallbackModel);
      logFlashFallback(
        config,
        new FlashFallbackEvent(config.getContentGeneratorConfig().authType!),
      );
      return false; // Don't continue with current prompt
    };

    config.setFlashFallbackHandler(flashFallbackHandler);
  }, [config, addItem, userTier]);

  const {
    handleSlashCommand,
    slashCommands,
    pendingHistoryItems: pendingSlashCommandHistoryItems,
    commandContext,
  } = useSlashCommandProcessor(
    config,
    settings,
    addItem,
    clearItems,
    loadHistory,
    refreshStatic,
    setShowHelp,
    setDebugMessage,
    openThemeDialog,
    openAuthDialog,
    openEditorDialog,
    toggleCorgiMode,
    setQuittingMessages,
    openPrivacyNotice,
  );
  const pendingHistoryItems = [...pendingSlashCommandHistoryItems];

  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();
  const isInitialMount = useRef(true);
  const { stdin, setRawMode } = useStdin();
  const isValidPath = useCallback((filePath: string): boolean => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_e) {
      return false;
    }
  }, []);

  const widthFraction = 0.9;
  const inputWidth = Math.max(
    20,
    Math.floor(terminalWidth * widthFraction) - 3,
  );
  const suggestionsWidth = Math.max(60, Math.floor(terminalWidth * 0.8));

  const buffer = useTextBuffer({
    initialText: '',
    viewport: { height: 10, width: inputWidth },
    stdin,
    setRawMode,
    isValidPath,
    shellModeActive,
  });

  const handleSuggestionsUpdate = useCallback((newSuggestions: string[]) => {
    setSuggestions(newSuggestions);
    setShowSuggestions(newSuggestions.length > 0);
  }, []);

  const geminiClient = config.getGeminiClient();

  // Use the new prompt completion hook
  usePromptCompletion(
    geminiClient,
    buffer.text,
    500, // 500ms delay
    handleSuggestionsUpdate,
    buffer.text.length > 5,
  );

  const handleExit = useCallback(
    (
      pressedOnce: boolean,
      setPressedOnce: (value: boolean) => void,
      timerRef: React.MutableRefObject<NodeJS.Timeout | null>,
    ) => {
      if (pressedOnce) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        // Directly invoke the central command handler.
        handleSlashCommand('/quit');
      } else {
        setPressedOnce(true);
        timerRef.current = setTimeout(() => {
          setPressedOnce(false);
          timerRef.current = null;
        }, CTRL_EXIT_PROMPT_DURATION_MS);
      }
    },
    [handleSlashCommand],
  );

  useInput((input: string, key: InkKeyType) => {
    let enteringConstrainHeightMode = false;
    if (!constrainHeight) {
      // Automatically re-enter constrain height mode if the user types
      // anything. When constrainHeight==false, the user will experience
      // significant flickering so it is best to disable it immediately when
      // the user starts interacting with the app.
      enteringConstrainHeightMode = true;
      setConstrainHeight(true);
    }

    if (key.escape) {
      if (ctrlCPressedOnce) {
        setCtrlCPressedOnce(false);
        if (ctrlCTimerRef.current) {
          clearTimeout(ctrlCTimerRef.current);
          ctrlCTimerRef.current = null;
        }
        return;
      }
      if (ctrlDPressedOnce) {
        setCtrlDPressedOnce(false);
        if (ctrlDTimerRef.current) {
          clearTimeout(ctrlDTimerRef.current);
          ctrlDTimerRef.current = null;
        }
        return;
      }
    } else if (key.ctrl && input === 'o') {
      setShowErrorDetails((prev) => !prev);
    } else if (key.ctrl && input === 't') {
      const newValue = !showToolDescriptions;
      setShowToolDescriptions(newValue);

      const mcpServers = config.getMcpServers();
      if (Object.keys(mcpServers || {}).length > 0) {
        handleSlashCommand(newValue ? '/mcp desc' : '/mcp nodesc');
      }
    } else if (key.ctrl && (input === 'c' || input === 'C')) {
      // Check if input buffer has content
      if (buffer.text.length > 0) {
        if (clearBufferFn) {
          clearBufferFn();
        } else {
          buffer.setText('');
        }
        setCtrlCPressedOnce(true);
        ctrlCTimerRef.current = setTimeout(() => {
          setCtrlCPressedOnce(false);
          ctrlCTimerRef.current = null;
        }, CTRL_EXIT_PROMPT_DURATION_MS);
      } else {
        handleExit(ctrlCPressedOnce, setCtrlCPressedOnce, ctrlCTimerRef);
      }
    } else if (key.ctrl && (input === 'd' || input === 'D')) {
      if (buffer.text.length > 0) {
        // Do nothing if there is text in the input.
        return;
      }
      handleExit(ctrlDPressedOnce, setCtrlDPressedOnce, ctrlDTimerRef);
    } else if (key.ctrl && input === 's' && !enteringConstrainHeightMode) {
      setConstrainHeight(false);
    } else if (key.shift && key.downArrow) {
      if (suggestions.length > 0) {
        buffer.setText(suggestions[0]);
        setShowSuggestions(false);
        setSuggestions([]);
      }
    }
  });

  useEffect(() => {
    if (config) {
      setGeminiMdFileCount(config.getGeminiMdFileCount());
    }
  }, [config]);

  const getPreferredEditor = useCallback(() => {
    const editorType = settings.merged.preferredEditor;
    const isValidEditor = isEditorAvailable(editorType);
    if (!isValidEditor) {
      openEditorDialog();
      return;
    }
    return editorType as EditorType;
  }, [settings, openEditorDialog]);

  const onAuthError = useCallback(() => {
    setAuthError('reauth required');
    openAuthDialog();
  }, [openAuthDialog, setAuthError]);

  const {
    streamingState,
    submitQuery,
    initError,
    pendingHistoryItems: pendingGeminiHistoryItems,
    thought,
  } = useGeminiStream(
    config.getGeminiClient(),
    history,
    addItem,
    setShowHelp,
    config,
    setDebugMessage,
    handleSlashCommand,
    shellModeActive,
    getPreferredEditor,
    onAuthError,
    performMemoryRefresh,
    modelSwitchedFromQuotaError,
    setModelSwitchedFromQuotaError,
  );
  pendingHistoryItems.push(...pendingGeminiHistoryItems);
  const { elapsedTime, currentLoadingPhrase } =
    useLoadingIndicator(streamingState);
  const showAutoAcceptIndicator = useAutoAcceptIndicator({ config });

  const handleFinalSubmit = useCallback(
    (submittedValue: string) => {
      setShowSuggestions(false);
      const trimmedValue = submittedValue.trim();
      if (trimmedValue.length > 0) {
        submitQuery(trimmedValue);
      }
    },
    [submitQuery],
  );

  const logger = useLogger();
  const [userMessages, setUserMessages] = useState<string[]>([]);

  useEffect(() => {
    const fetchUserMessages = async () => {
      const pastMessagesRaw = (await logger?.getPreviousUserMessages()) || []; // Newest first

      const currentSessionUserMessages = history
        .filter(
          (item): item is HistoryItem & { type: 'user'; text: string } =>
            item.type === 'user' &&
            typeof item.text === 'string' &&
            item.text.trim() !== '',
        )
        .map((item) => item.text)
        .reverse(); // Newest first, to match pastMessagesRaw sorting

      // Combine, with current session messages being more recent
      const combinedMessages = [
        ...currentSessionUserMessages,
        ...pastMessagesRaw,
      ];

      // Deduplicate consecutive identical messages from the combined list (still newest first)
      const deduplicatedMessages: string[] = [];
      if (combinedMessages.length > 0) {
        deduplicatedMessages.push(combinedMessages[0]); // Add the newest one unconditionally
        for (let i = 1; i < combinedMessages.length; i++) {
          if (combinedMessages[i] !== combinedMessages[i - 1]) {
            deduplicatedMessages.push(combinedMessages[i]);
          }
        }
      }
      // Reverse to oldest first for useInputHistory
      setUserMessages(deduplicatedMessages.reverse());
    };
    fetchUserMessages();
  }, [history, logger]);

  const isInputActive = streamingState === StreamingState.Idle && !initError;

  const handleClearScreen = useCallback(() => {
    clearItems();
    clearConsoleMessagesState();
    console.clear();
    refreshStatic();
  }, [clearItems, clearConsoleMessagesState, refreshStatic]);

  const mainControlsRef = useRef<DOMElement>(null);
  const pendingHistoryItemRef = useRef<DOMElement>(null);

  useEffect(() => {
    if (mainControlsRef.current) {
      const fullFooterMeasurement = measureElement(mainControlsRef.current);
      setFooterHeight(fullFooterMeasurement.height);
    }
  }, [terminalHeight, consoleMessages, showErrorDetails]);

  const staticExtraHeight = /* margins and padding */ 3;
  const availableTerminalHeight = useMemo(
    () => terminalHeight - footerHeight - staticExtraHeight,
    [terminalHeight, footerHeight],
  );

  useEffect(() => {
    // skip refreshing Static during first mount
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // debounce so it doesn't fire up too often during resize
    const handler = setTimeout(() => {
      setStaticNeedsRefresh(false);
      refreshStatic();
    }, 300);

    return () => {
      clearTimeout(handler);
    };
  }, [terminalWidth, terminalHeight, refreshStatic]);

  useEffect(() => {
    if (streamingState === StreamingState.Idle && staticNeedsRefresh) {
      setStaticNeedsRefresh(false);
      refreshStatic();
    }
  }, [streamingState, refreshStatic, staticNeedsRefresh]);

  const filteredConsoleMessages = useMemo(() => {
    if (config.getDebugMode()) {
      return consoleMessages;
    }
    return consoleMessages.filter((msg) => msg.type !== 'debug');
  }, [consoleMessages, config]);

  const branchName = useGitBranchName(config.getTargetDir());

  const contextFileNames = useMemo(() => {
    const fromSettings = settings.merged.contextFileName;
    if (fromSettings) {
      return Array.isArray(fromSettings) ? fromSettings : [fromSettings];
    }
    return getAllGeminiMdFilenames();
  }, [settings.merged.contextFileName]);

  const initialPrompt = useMemo(() => config.getQuestion(), [config]);

  useEffect(() => {
    if (
      initialPrompt &&
      !initialPromptSubmitted.current &&
      !isAuthenticating &&
      !isAuthDialogOpen &&
      !isThemeDialogOpen &&
      !isEditorDialogOpen &&
      !showPrivacyNotice &&
      geminiClient?.isInitialized?.()
    ) {
      submitQuery(initialPrompt);
      initialPromptSubmitted.current = true;
    }
  }, [
    initialPrompt,
    submitQuery,
    isAuthenticating,
    isAuthDialogOpen,
    isThemeDialogOpen,
    isEditorDialogOpen,
    showPrivacyNotice,
    geminiClient,
  ]);

  if (quittingMessages) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {quittingMessages.map((item) => (
          <HistoryItemDisplay
            key={item.id}
            availableTerminalHeight={
              constrainHeight ? availableTerminalHeight : undefined
            }
            terminalWidth={terminalWidth}
            item={item}
            isPending={false}
            config={config}
          />
        ))}
      </Box>
    );
  }
  const mainAreaWidth = Math.floor(terminalWidth * 0.9);
  const debugConsoleMaxHeight = Math.floor(Math.max(terminalHeight * 0.2, 5));
  // Arbitrary threshold to ensure that items in the static area are large
  // enough but not too large to make the terminal hard to use.
  const staticAreaMaxItemHeight = Math.max(terminalHeight * 4, 100);
  return (
    <StreamingContext.Provider value={streamingState}>
      <Box flexDirection="column" marginBottom={1} width="90%">
        {/*
         * The Static component is an Ink intrinsic in which there can only be 1 per application.
         * Because of this restriction we're hacking it slightly by having a 'header' item here to
         * ensure that it's statically rendered.
         *
         * Background on the Static Item: Anything in the Static component is written a single time
         * to the console. Think of it like doing a console.log and then never using ANSI codes to
         * clear that content ever again. Effectively it has a moving frame that every time new static
         * content is set it'll flush content to the terminal and move the area which it's "clearing"
         * down a notch. Without Static the area which gets erased and redrawn continuously grows.
         */}
        <Static
          key={staticKey}
          items={[
            <Box flexDirection="column" key="header">
              {!settings.merged.hideBanner && (
                <Header
                  terminalWidth={terminalWidth}
                  version={version}
                  nightly={nightly}
                />
              )}
              {!settings.merged.hideTips && <Tips config={config} />}
            </Box>,
            ...history.map((h) => (
              <HistoryItemDisplay
                terminalWidth={mainAreaWidth}
                availableTerminalHeight={staticAreaMaxItemHeight}
                key={h.id}
                item={h}
                isPending={false}
                config={config}
              />
            )),
          ]}
        >
          {(item) => item}
        </Static>
        <OverflowProvider>
          <Box ref={pendingHistoryItemRef} flexDirection="column">
            {pendingHistoryItems.map((item, i) => (
              <HistoryItemDisplay
                key={i}
                availableTerminalHeight={
                  constrainHeight ? availableTerminalHeight : undefined
                }
                terminalWidth={mainAreaWidth}
                // TODO(taehykim): It seems like references to ids aren't necessary in
                // HistoryItemDisplay. Refactor later. Use a fake id for now.
                item={{ ...item, id: 0 }}
                isPending={true}
                config={config}
                isFocused={!isEditorDialogOpen}
              />
            ))}
            <ShowMoreLines constrainHeight={constrainHeight} />
          </Box>
        </OverflowProvider>

        {showHelp && <Help commands={slashCommands} />}

        <Box flexDirection="column" ref={mainControlsRef}>
          {/* Move UpdateNotification to render update notification above input area */}
          {updateInfo && (
            <UpdateNotification
              message={
                isUpdating
                  ? `${updateInfo.message}\nAttempting to automatically update now...`
                  : `${updateInfo.message}\nRun npm install -g ${updateInfo.update.name} to update`
              }
            />
          )}
          {startupWarnings.length > 0 && (
            <Box
              borderStyle="round"
              borderColor={Colors.AccentYellow}
              paddingX={1}
              marginY={1}
              flexDirection="column"
            >
              {startupWarnings.map((warning, index) => (
                <Text key={index} color={Colors.AccentYellow}>
                  {warning}
                </Text>
              ))}
            </Box>
          )}

          {isThemeDialogOpen ? (
            <Box flexDirection="column">
              {themeError && (
                <Box marginBottom={1}>
                  <Text color={Colors.AccentRed}>{themeError}</Text>
                </Box>
              )}
              <ThemeDialog
                onSelect={handleThemeSelect}
                onHighlight={handleThemeHighlight}
                settings={settings}
                availableTerminalHeight={
                  constrainHeight
                    ? terminalHeight - staticExtraHeight
                    : undefined
                }
                terminalWidth={mainAreaWidth}
              />
            </Box>
          ) : isAuthenticating ? (
            <>
              <AuthInProgress
                onTimeout={() => {
                  setAuthError('Authentication timed out. Please try again.');
                  cancelAuthentication();
                  openAuthDialog();
                }}
              />
              {showErrorDetails && (
                <OverflowProvider>
                  <Box flexDirection="column">
                    <DetailedMessagesDisplay
                      messages={filteredConsoleMessages}
                      maxHeight={
                        constrainHeight ? debugConsoleMaxHeight : undefined
                      }
                      width={inputWidth}
                    />
                    <ShowMoreLines constrainHeight={constrainHeight} />
                  </Box>
                </OverflowProvider>
              )}
            </>
          ) : isAuthDialogOpen ? (
            <Box flexDirection="column">
              <AuthDialog
                onSelect={handleAuthSelect}
                settings={settings}
                initialErrorMessage={authError}
              />
            </Box>
          ) : isEditorDialogOpen ? (
            <Box flexDirection="column">
              {editorError && (
                <Box marginBottom={1}>
                  <Text color={Colors.AccentRed}>{editorError}</Text>
                </Box>
              )}
              <EditorSettingsDialog
                onSelect={handleEditorSelect}
                settings={settings}
                onExit={exitEditorDialog}
              />
            </Box>
          ) : showPrivacyNotice ? (
            <PrivacyNotice
              onExit={() => setShowPrivacyNotice(false)}
              config={config}
            />
          ) : passwordRequest ? (
            <PasswordPrompt
              prompt={passwordRequest.prompt}
              onSubmit={(password) => {
                passwordRequest.resolve(password);
                setPasswordRequest(null);
              }}
              onCancel={() => {
                passwordRequest.resolve(null);
                setPasswordRequest(null);
              }}
            />
          ) : (
            <>
              <LoadingIndicator
                thought={
                  streamingState === StreamingState.WaitingForConfirmation ||
                  config.getAccessibility()?.disableLoadingPhrases
                    ? undefined
                    : thought
                }
                currentLoadingPhrase={
                  config.getAccessibility()?.disableLoadingPhrases
                    ? undefined
                    : currentLoadingPhrase
                }
                elapsedTime={elapsedTime}
              />
              <Box
                marginTop={1}
                display="flex"
                justifyContent="space-between"
                width="100%"
              >
                <Box>
                  {process.env.GEMINI_SYSTEM_MD && (
                    <Text color={Colors.AccentRed}>|⌐■_■| </Text>
                  )}
                  {ctrlCPressedOnce ? (
                    <Text color={Colors.AccentYellow}>
                      Press Ctrl+C again to exit.
                    </Text>
                  ) : ctrlDPressedOnce ? (
                    <Text color={Colors.AccentYellow}>
                      Press Ctrl+D again to exit.
                    </Text>
                  ) : showEscapePrompt ? (
                    <Text color={Colors.Gray}>
                      Press Escape again to clear.
                    </Text>
                  ) : (
                    <ContextSummaryDisplay
                      openFiles={openFiles}
                      geminiMdFileCount={geminiMdFileCount}
                      contextFileNames={contextFileNames}
                      mcpServers={config.getMcpServers()}
                      blockedMcpServers={config.getBlockedMcpServers()}
                      showToolDescriptions={showToolDescriptions}
                    />
                  )}
                </Box>
                <Box>
                  {showAutoAcceptIndicator !== ApprovalMode.DEFAULT &&
                    !shellModeActive && (
                      <AutoAcceptIndicator
                        approvalMode={showAutoAcceptIndicator}
                      />
                    )}
                  {shellModeActive && <ShellModeIndicator />}
                </Box>
              </Box>

              {showErrorDetails && (
                <OverflowProvider>
                  <Box flexDirection="column">
                    <DetailedMessagesDisplay
                      messages={filteredConsoleMessages}
                      maxHeight={
                        constrainHeight ? debugConsoleMaxHeight : undefined
                      }
                      width={inputWidth}
                    />
                    <ShowMoreLines constrainHeight={constrainHeight} />
                  </Box>
                </OverflowProvider>
              )}

              {isInputActive && (
                <InputPrompt
                  buffer={buffer}
                  inputWidth={inputWidth}
                  suggestionsWidth={suggestionsWidth}
                  onSubmit={handleFinalSubmit}
                  userMessages={userMessages}
                  onClearScreen={handleClearScreen}
                  config={config}
                  slashCommands={slashCommands}
                  commandContext={commandContext}
                  shellModeActive={shellModeActive}
                  setShellModeActive={setShellModeActive}
                  onEscapePromptChange={handleEscapePromptChange}
                  onClearBuffer={handleClearBuffer}
                />
              )}
              {showSuggestions && suggestions.length > 0 && (
                <Box
                  flexDirection="column"
                  borderStyle="round"
                  paddingX={1}
                  marginTop={1}
                  borderColor={Colors.AccentBlue}
                >
                  <Text color={Colors.AccentBlue} bold>
                    💡 Prompt Suggestion:
                  </Text>
                  {suggestions.map((suggestion, index) => (
                    <Box
                      key={index}
                      marginLeft={2}
                      marginBottom={index === suggestions.length - 1 ? 0 : 1}
                    >
                      <Text color={Colors.Comment}>
                        {index + 1}. {suggestion}
                      </Text>
                    </Box>
                  ))}
                  <Box marginTop={1}>
                    <Text color={Colors.Comment}>
                      Tips: You can copy the above suggestions as your prompt
                      words. (Shift + Down Arrow)
                    </Text>
                  </Box>
                </Box>
              )}
            </>
          )}

          {initError && streamingState !== StreamingState.Responding && (
            <Box
              borderStyle="round"
              borderColor={Colors.AccentRed}
              paddingX={1}
              marginBottom={1}
            >
              {history.find(
                (item) =>
                  item.type === 'error' && item.text?.includes(initError),
              )?.text ? (
                <Text color={Colors.AccentRed}>
                  {
                    history.find(
                      (item) =>
                        item.type === 'error' && item.text?.includes(initError),
                    )?.text
                  }
                </Text>
              ) : (
                <>
                  <Text color={Colors.AccentRed}>
                    Initialization Error: {initError}
                  </Text>
                  <Text color={Colors.AccentRed}>
                    {' '}
                    Please check API key and configuration.
                  </Text>
                </>
              )}
            </Box>
          )}
          <Footer
            model={currentModel}
            targetDir={config.getTargetDir()}
            debugMode={config.getDebugMode()}
            branchName={branchName}
            debugMessage={debugMessage}
            corgiMode={corgiMode}
            errorCount={errorCount}
            showErrorDetails={showErrorDetails}
            showMemoryUsage={
              config.getDebugMode() || config.getShowMemoryUsage()
            }
            promptTokenCount={sessionStats.lastPromptTokenCount}
            nightly={nightly}
          />
        </Box>
      </Box>
    </StreamingContext.Provider>
  );
};
