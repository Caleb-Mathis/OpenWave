// Web Audio API Global instances
let audioContext = null;
let microphoneStream = null;
let mediaStreamNode = null;
let analyserNode = null;
let recorderNode = null;

// ggwave Global instances
let ggwave = null;
let ggwaveInstance = null;
let ggwaveInstanceShifted = null;
let ggwaveParameters = null;
let protocolsMap = null;

// App Configuration State
let currentProtocolId = null; // Map to ggwave.ProtocolId objects
let txVolume = 0.6; // Outgoing volume multiplier (0.1 - 1.0)
let rxGain = 1.0; // Microphone input gain multiplier
let isCapturing = false;
let isTransmitting = false;
let soundFeedbackEnabled = true;
let micAccessGranted = localStorage.getItem('wavest_mic_granted') === '1';

// Secure Communication State
const DEFAULT_CALLSIGN = 'OpenWave User';
let myCallsign = DEFAULT_CALLSIGN;
let myPasskey = '';
let contactKeys = {};
let encryptionEnabled = false;
let settingsStack = ['root'];
let editingCallsign = null;

// Visualization configuration
let animationFrameId = null;
let sendVizRaf = null;

// DOM Elements
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const chatMessages = document.getElementById('chat-messages');
const rxStateIcon = document.getElementById('rx-state-icon');
const rxStateText = document.getElementById('rx-state-text');
const captureToggleBtn = document.getElementById('capture-toggle-btn');
const navSubtitle = document.getElementById('nav-subtitle');
const protocolToggleBtn = document.getElementById('protocol-toggle-btn');
const ultrasoundToggle = document.getElementById('ultrasound-toggle');
const protocolRateRange = document.getElementById('protocol-rate');
const protocolRateVal = document.getElementById('protocol-rate-val');
const chatThread = document.getElementById('chat-thread');

const RATE_NAMES = ['Normal', 'Fast', 'Fastest'];
let protocolBand = 'ultrasound';
let protocolRate = 2;
let listenLabel = 'Ready';

// Send spectrogram (decorative, transmit-only)
const sendVizCanvas = document.getElementById('send-viz-canvas');
const sendVizCtx = sendVizCanvas ? sendVizCanvas.getContext('2d') : null;

// Settings Sidebar DOM
const settingsSidebar = document.getElementById('settings-sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const openSettingsBtn = document.getElementById('open-settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const volumeRange = document.getElementById('volume-range');
const volumeVal = document.getElementById('volume-val');
const sensitivityRange = document.getElementById('sensitivity-range');
const sensitivityVal = document.getElementById('sensitivity-val');
const soundFeedbackToggle = document.getElementById('sound-feedback-toggle');
const loopbackTestBtn = document.getElementById('loopback-test-btn');
const testResult = document.getElementById('test-result');
const clearChatBtn = document.getElementById('clear-chat-btn');
const engineStatusLabel = document.getElementById('engine-status-label');
const engineStatusDetail = document.getElementById('engine-status-detail');
const appToast = document.getElementById('app-toast');
// Instantiate ggwave on page load
window.addEventListener('DOMContentLoaded', () => {
    // Resize canvases to fit wrappers
    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);

    applyTheme('midnight', false);
    setupViewportLock();
    setupLayoutDebug();
    registerServiceWorker();
    setEngineStatus('init', 'Starting ggwave…');

    // Hook up ggwave factory
    if (typeof ggwave_factory !== 'undefined') {
        ggwave_factory().then((obj) => {
            ggwave = obj;
            console.log('ggwave WASM engine loaded successfully');
            
            // Map protocol selection values to Emscripten Enum objects
            if (ggwave.ProtocolId) {
                protocolsMap = {
                    0: ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_NORMAL,
                    1: ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST,
                    2: ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
                    3: ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_NORMAL,
                    4: ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST,
                    5: ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FASTEST
                };
                currentProtocolId = getActiveProtocol(); // Default: Ultrasound (Fastest)
            }
            setEngineStatus('ready', 'ggwave WebAssembly engine successfully initialized locally.');
            updateSendEnabled();
        }).catch((err) => {
            console.error('Failed to load ggwave WASM factory:', err);
            setEngineStatus('error', 'WebAssembly compiler failed to load ggwave binary. Make sure JavaScript/DOM storage is allowed.');
            showToast('Engine failed to load', true);
        });
    } else {
        setEngineStatus('error', 'ggwave.js library not found or failed to load in WebView.');
        showToast('Engine failed to load', true);
    }

    // Bind UI Event Listeners
    setupUIEventListeners();
});

// Helper for type conversions required by emscripten C++ boundary
function convertTypedArray(src, type) {
    const buffer = new ArrayBuffer(src.byteLength);
    new src.constructor(buffer).set(src);
    return new type(buffer);
}

// Canvas size adjusters
function measureCanvasBox(el, fallbackH) {
    if (!el) return { w: 300, h: fallbackH };
    let w = el.clientWidth;
    let h = el.clientHeight;
    if (w < 2 || h < 2) {
        const app = document.querySelector('.app-container');
        w = Math.max(2, (app ? app.clientWidth : window.innerWidth) - 48);
        h = fallbackH;
    }
    return { w, h };
}

function isTextField(el) {
    if (!el || el === document.body) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function isStandaloneDisplay() {
    return window.navigator.standalone === true
        || window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: fullscreen)').matches;
}

function chatDistanceFromBottom() {
    if (!chatMessages) return 0;
    return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight;
}

function pinChatToLatest() {
    if (!chatMessages) return;
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setupViewportLock() {
    const root = document.documentElement;
    const HINT_KEY = 'wavest_kb_inset';
    let lastInset = -1;
    let trackingUntil = 0;
    let trackRaf = 0;
    let pinnedToLatest = true;

    if (isStandaloneDisplay()) {
        document.documentElement.classList.add('standalone');
        document.body.classList.add('standalone');
    }

    if (navigator.virtualKeyboard) {
        try {
            navigator.virtualKeyboard.overlaysContent = true;
        } catch (err) {
            /* Safari may expose the object without this setter */
        }
    }

    if (chatMessages) {
        chatMessages.addEventListener('scroll', () => {
            pinnedToLatest = chatDistanceFromBottom() < 80;
        }, { passive: true });
    }

    const measuredInset = () => {
        const vv = window.visualViewport;
        const layoutH = window.innerHeight;
        const vvH = vv ? vv.height : layoutH;
        const vvTop = vv ? vv.offsetTop : 0;
        const fromViewport = Math.max(0, layoutH - vvH - vvTop);
        const fromVk = (navigator.virtualKeyboard && navigator.virtualKeyboard.boundingRect)
            ? navigator.virtualKeyboard.boundingRect.height
            : 0;
        return Math.max(fromViewport, fromVk);
    };

    const restorePinnedChat = (force) => {
        if (!chatMessages) return;
        if (force || pinnedToLatest) pinChatToLatest();
    };

    const scheduleChatRestore = () => {
        restorePinnedChat(true);
        requestAnimationFrame(() => {
            restorePinnedChat(true);
            requestAnimationFrame(() => restorePinnedChat(true));
        });
        [50, 120, 280, 480].forEach((ms) => {
            setTimeout(() => restorePinnedChat(true), ms);
        });
    };

    const apply = () => {
        if (window.scrollY !== 0 || window.scrollX !== 0) {
            window.scrollTo(0, 0);
        }

        const typing = isTextField(document.activeElement);
        let inset = 0;

        if (typing) {
            inset = measuredInset();
            if (inset < 80) {
                const hinted = Number(sessionStorage.getItem(HINT_KEY) || 0);
                if (lastInset > 80) inset = lastInset;
                else if (hinted > 80) inset = hinted;
            }
            if (inset > 80) {
                sessionStorage.setItem(HINT_KEY, String(Math.round(inset)));
            } else {
                inset = 0;
            }
        }

        const keyboardOpen = typing && inset > 80;
        document.body.classList.toggle('keyboard-open', keyboardOpen);

        if (Math.abs(inset - lastInset) > 0.5) {
            lastInset = inset;
            root.style.setProperty('--kb-js', `${inset}px`);
            if (chatMessages) void chatMessages.offsetHeight;
            resizeCanvases();
        }

        if (keyboardOpen) restorePinnedChat(true);
    };

    const track = () => {
        apply();
        if (performance.now() < trackingUntil) {
            trackRaf = requestAnimationFrame(track);
        } else {
            trackRaf = 0;
        }
    };

    const startTracking = (ms) => {
        trackingUntil = Math.max(trackingUntil, performance.now() + ms);
        if (!trackRaf) trackRaf = requestAnimationFrame(track);
    };

    const prelift = () => {
        pinnedToLatest = true;
        let inset = measuredInset();
        if (inset < 80) {
            const hinted = Number(sessionStorage.getItem(HINT_KEY) || 0);
            if (hinted > 80) {
                inset = hinted;
            } else if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
                || window.matchMedia('(pointer: coarse)').matches) {
                inset = 300;
            }
        }
        if (inset > 80) {
            lastInset = inset;
            root.style.setProperty('--kb-js', `${inset}px`);
            document.body.classList.add('keyboard-open');
            if (chatMessages) void chatMessages.offsetHeight;
            scheduleChatRestore();
        }
        startTracking(700);
    };

    apply();
    window.addEventListener('resize', () => startTracking(400));
    window.addEventListener('orientationchange', () => {
        sessionStorage.removeItem(HINT_KEY);
        startTracking(500);
    });
    window.addEventListener('scroll', () => {
        window.scrollTo(0, 0);
        if (document.body.classList.contains('keyboard-open')) restorePinnedChat(true);
    }, { passive: false });

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => startTracking(400));
        window.visualViewport.addEventListener('scroll', () => {
            window.scrollTo(0, 0);
            if (document.body.classList.contains('keyboard-open')) restorePinnedChat(true);
            startTracking(400);
        });
    }

    if (navigator.virtualKeyboard) {
        navigator.virtualKeyboard.addEventListener('geometrychange', () => startTracking(400));
    }

    document.addEventListener('focusin', (event) => {
        if (!isTextField(event.target)) return;
        prelift();
    });
    document.addEventListener('focusout', () => startTracking(400));

    if (messageInput) {
        messageInput.addEventListener('touchstart', prelift, { passive: true });
    }

    document.addEventListener('touchmove', (event) => {
        if (event.touches.length > 1) return;
        const scrollable = event.target.closest('.chat-messages, .sidebar-content, textarea');
        if (!scrollable) event.preventDefault();
    }, { passive: false });
}

function probeCssHeight(value) {
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;left:0;top:0;width:0;height:${value};visibility:hidden;pointer-events:none;`;
    document.documentElement.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return Math.round(height || 0);
}

function readSafeInset(side) {
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;padding-${side}:env(safe-area-inset-${side}, 0px);`;
    document.documentElement.appendChild(probe);
    const key = `padding${side.charAt(0).toUpperCase()}${side.slice(1)}`;
    const value = parseFloat(getComputedStyle(probe)[key]) || 0;
    probe.remove();
    return Math.round(value);
}

function setupLayoutDebug() {
    const panel = document.getElementById('layout-debug');
    const title = document.querySelector('.nav-titles h1');
    if (!panel) return;

    const params = new URLSearchParams(window.location.search);
    let enabled = params.get('debug') === '1' || sessionStorage.getItem('wavest_layout_debug') === '1';
    let tapCount = 0;
    let tapTimer = 0;

    const paint = () => {
        if (!enabled) return;
        const vv = window.visualViewport;
        const app = document.querySelector('.app-container');
        const composer = document.querySelector('.composer');
        const appBox = app ? app.getBoundingClientRect() : null;
        const composerBox = composer ? composer.getBoundingClientRect() : null;
        const cs = composer ? getComputedStyle(composer) : null;
        const lines = [
            `standalone ${isStandaloneDisplay() ? 'yes' : 'no'}  nav.standalone ${window.navigator.standalone ? 'yes' : 'no'}`,
            `inner ${window.innerWidth}x${window.innerHeight}  client ${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`,
            `outer ${window.outerWidth}x${window.outerHeight}  screen ${window.screen.width}x${window.screen.height}`,
            `vv ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)} top=${Math.round(vv.offsetTop)}` : 'n/a'}`,
            `svh ${probeCssHeight('100svh')}  dvh ${probeCssHeight('100dvh')}  lvh ${probeCssHeight('100lvh')}`,
            `fill ${probeCssHeight('-webkit-fill-available')}`,
            `safe t${readSafeInset('top')} r${readSafeInset('right')} b${readSafeInset('bottom')} l${readSafeInset('left')}`,
            `kb-js ${getComputedStyle(document.documentElement).getPropertyValue('--kb-js').trim() || '0'}`,
            `composer pad ${cs ? cs.paddingBottom : '?'}  bottom ${cs ? cs.bottom : '?'}`,
            `app rect y=${appBox ? Math.round(appBox.top) : '?'} h=${appBox ? Math.round(appBox.height) : '?'} bottom=${appBox ? Math.round(appBox.bottom) : '?'}`,
            `field rect y=${composerBox ? Math.round(composerBox.top) : '?'} h=${composerBox ? Math.round(composerBox.height) : '?'} bottom=${composerBox ? Math.round(composerBox.bottom) : '?'}`,
            `gap under field ${composerBox && appBox ? Math.round(appBox.bottom - composerBox.bottom) : '?'}px`,
            `gap under app ${appBox ? Math.round(window.innerHeight - appBox.bottom) : '?'}px`,
            `triple-tap OpenWave to hide`
        ];
        panel.textContent = lines.join('\n');
    };

    const setEnabled = (next) => {
        enabled = next;
        sessionStorage.setItem('wavest_layout_debug', next ? '1' : '0');
        document.documentElement.classList.toggle('layout-debug-on', next);
        panel.hidden = !next;
        if (next) paint();
    };

    if (title) {
        title.addEventListener('click', () => {
            tapCount += 1;
            clearTimeout(tapTimer);
            tapTimer = setTimeout(() => { tapCount = 0; }, 500);
            if (tapCount >= 3) {
                tapCount = 0;
                setEnabled(!enabled);
            }
        });
    }

    setEnabled(enabled);
    window.addEventListener('resize', paint);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', paint);
        window.visualViewport.addEventListener('scroll', paint);
    }
    setInterval(() => { if (enabled) paint(); }, 500);
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
    });
}

function resizeCanvases() {
    if (!sendVizCanvas || !sendVizCtx) return;
    const parent = sendVizCanvas.parentElement;
    const w = parent ? parent.clientWidth : 300;
    const h = sendVizCanvas.clientHeight || 168;
    sendVizCanvas.width = Math.max(2, w);
    sendVizCanvas.height = Math.max(2, h);
    sendVizCtx.clearRect(0, 0, sendVizCanvas.width, sendVizCanvas.height);
}

// Set up UI inputs, slider changes, sidebars
function setupUIEventListeners() {
    // Send message triggers
    sendBtn.addEventListener('click', transmitMessage);
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') transmitMessage();
    });

    // Capture Toggle Listener
    captureToggleBtn.addEventListener('click', toggleAudioCapture);

    bindSettingsNavigation();

    if (messageInput) {
        messageInput.addEventListener('input', updateSendEnabled);
    }

    // Load secure settings on startup
    loadSecureSettings();
    loadProtocolSettings();
    bindSecureSettingsListeners();
    bindProtocolSettings();

    bindRangeFills();

    volumeRange.addEventListener('input', (e) => {
        txVolume = parseFloat(e.target.value) / 100;
        volumeVal.innerText = e.target.value;
    });

    sensitivityRange.addEventListener('input', (e) => {
        rxGain = parseFloat(e.target.value);
        sensitivityVal.innerText = e.target.value.includes('.') ? e.target.value : e.target.value + '.0';
    });

    soundFeedbackToggle.addEventListener('change', (e) => {
        soundFeedbackEnabled = e.target.checked;
    });

    loopbackTestBtn.addEventListener('click', runDiagnosticsLoopback);

    if (clearChatBtn) {
        clearChatBtn.addEventListener('click', () => {
            if (chatThread) chatThread.innerHTML = '';
            else chatMessages.innerHTML = '';
            closeSettings();
        });
    }
}

function sendVizBand(sampleRate, windowSize) {
    const high = protocolBand === 'ultrasound';
    const f0 = high ? 14000 : 400;
    const f1 = high ? Math.min(22000, sampleRate / 2) : 8000;
    return {
        start: Math.max(1, Math.floor((f0 * windowSize) / sampleRate)),
        end: Math.max(2, Math.ceil((f1 * windowSize) / sampleRate))
    };
}

function fillSpectrumSlice(samples, offset, windowSize, band, dest) {
    const bins = dest.length;
    const span = Math.max(1, band.end - band.start);
    for (let b = 0; b < bins; b++) {
        const k = band.start + ((b + 0.5) * span) / bins;
        let re = 0;
        let im = 0;
        const step = 2;
        for (let i = 0; i < windowSize; i += step) {
            const idx = offset + i;
            const s = idx >= 0 && idx < samples.length ? samples[idx] : 0;
            const ang = (2 * Math.PI * k * i) / windowSize;
            re += s * Math.cos(ang);
            im -= s * Math.sin(ang);
        }
        dest[b] = Math.sqrt(re * re + im * im) * (step / windowSize);
    }
}

function startSendViz(floatArray, encrypted = false) {
    if (!sendVizCanvas || !sendVizCtx || !audioContext || !floatArray || !floatArray.length) return;
    resizeCanvases();
    sendVizCtx.clearRect(0, 0, sendVizCanvas.width, sendVizCanvas.height);
    sendVizCanvas.classList.add('active');

    const windowSize = 512;
    const columns = 36;
    const mags = new Float32Array(columns);
    const smoothed = new Float32Array(columns);
    const band = sendVizBand(audioContext.sampleRate, windowSize);
    const txStartTime = audioContext.currentTime;
    const rgb = hexToRgb(cssVar(
        encrypted ? '--bubble-sent-encrypted' : '--bubble-sent',
        encrypted ? '#9d3bff' : '#0a84ff'
    ));

    const draw = () => {
        if (!isTransmitting) {
            stopSendViz();
            return;
        }
        sendVizRaf = requestAnimationFrame(draw);

        const w = sendVizCanvas.width;
        const h = sendVizCanvas.height;
        if (w < 2 || h < 2) {
            resizeCanvases();
            return;
        }

        const samplePos = Math.floor((audioContext.currentTime - txStartTime) * audioContext.sampleRate);
        fillSpectrumSlice(floatArray, samplePos - windowSize, windowSize, band, mags);

        let peak = 0.0001;
        for (let i = 0; i < columns; i++) {
            if (mags[i] > peak) peak = mags[i];
        }

        for (let i = 0; i < columns; i++) {
            const t = Math.min(1, mags[i] / peak);
            smoothed[i] = smoothed[i] * 0.65 + t * 0.35;
        }
        const bloomed = new Float32Array(columns);
        const pass = (src, dest) => {
            for (let i = 0; i < columns; i++) {
                const prev = i > 0 ? src[i - 1] : src[i];
                const next = i < columns - 1 ? src[i + 1] : src[i];
                dest[i] = prev * 0.25 + src[i] * 0.5 + next * 0.25;
            }
        };
        pass(smoothed, bloomed);
        pass(bloomed, smoothed);
        pass(smoothed, bloomed);

        sendVizCtx.clearRect(0, 0, w, h);
        const slice = w / columns;
        for (let i = 0; i < columns; i++) {
            const t = bloomed[i];
            if (t < 0.08) continue;
            const barH = t * h * 0.9;
            const x = Math.floor(i * slice) - 2;
            const gradient = sendVizCtx.createLinearGradient(0, h, 0, h - barH);
            gradient.addColorStop(0, `rgba(${rgb}, ${0.04 + t * 0.14})`);
            gradient.addColorStop(1, `rgba(${rgb}, 0)`);
            sendVizCtx.fillStyle = gradient;
            sendVizCtx.fillRect(x, h - barH, Math.ceil(slice) + 5, barH);
        }
    };

    draw();
}

function stopSendViz() {
    if (sendVizRaf) {
        cancelAnimationFrame(sendVizRaf);
        sendVizRaf = null;
    }
    if (sendVizCanvas) {
        sendVizCanvas.classList.remove('active');
    }
}

function initAudio() {
    if (!audioContext) {
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext({ sampleRate: 48000 });
        ggwaveParameters = ggwave.getDefaultParameters();
        ggwaveParameters.sampleRateInp = audioContext.sampleRate;
        ggwaveParameters.sampleRateOut = audioContext.sampleRate;
        ggwaveInstance = ggwave.init(ggwaveParameters);
        ggwaveInstanceShifted = ggwave.init(ggwaveParameters);
        console.log(`Audio Context initialized. Sample Rate: ${audioContext.sampleRate} Hz`);
    }
}

function toggleAudioCapture() {
    initAudio();
    if (isCapturing) {
        stopAudioCapture();
    } else {
        startAudioCapture();
    }
}

function isMicPermissionError(err) {
    return !!(err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'));
}

function startAudioCapture() {
    if (!audioContext || !ggwave) return;

    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    const constraints = {
        audio: {
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: false
        }
    };

    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        micAccessGranted = true;
        localStorage.setItem('wavest_mic_granted', '1');
        microphoneStream = stream;
        mediaStreamNode = audioContext.createMediaStreamSource(stream);

        analyserNode = audioContext.createAnalyser();
        mediaStreamNode.connect(analyserNode);

        const bufferSize = 1024;
        if (audioContext.createScriptProcessor) {
            recorderNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
        } else {
            recorderNode = audioContext.createJavaScriptNode(bufferSize, 1, 1);
        }

        const handleDecodedBytes = async (bytes) => {
            try {
                const rawText = new TextDecoder('utf-8').decode(bytes);
                console.log('Successfully decoded raw sonic payload:', rawText);
                const parsed = await parseReceivedPacket(rawText);
                appendMessage(parsed.sender, parsed.message, 'received', parsed.encrypted);
                playReceivedChime();
            } catch (decodeErr) {
                console.error('Decoding text payload failed:', decodeErr);
            }
        };

        let isProcessingAudio = false;
        recorderNode.onaudioprocess = async (e) => {
            if (isTransmitting || isProcessingAudio) return;

            const channelDataCopy = new Float32Array(e.inputBuffer.getChannelData(0));
            isProcessingAudio = true;
            try {
                if (rxGain !== 1.0) {
                    for (let i = 0; i < channelDataCopy.length; i++) {
                        channelDataCopy[i] *= rxGain;
                    }
                }

                const samplesInt8 = convertTypedArray(channelDataCopy, Int8Array);
                const decodedBytes = ggwave.decode(ggwaveInstance, samplesInt8);
                if (decodedBytes && decodedBytes.length > 0) {
                    await handleDecodedBytes(decodedBytes);
                } else {
                    const shiftFactor = 1.0867;
                    const resampled = resampleBuffer(channelDataCopy, shiftFactor);
                    const resampledInt8 = convertTypedArray(resampled, Int8Array);
                    const decodedBytesShifted = ggwave.decode(ggwaveInstanceShifted, resampledInt8);
                    if (decodedBytesShifted && decodedBytesShifted.length > 0) {
                        await handleDecodedBytes(decodedBytesShifted);
                    }
                }
            } finally {
                isProcessingAudio = false;
            }
        };

        mediaStreamNode.connect(recorderNode);
        recorderNode.connect(audioContext.destination);

        isCapturing = true;
        captureToggleBtn.classList.add('active');
        captureToggleBtn.setAttribute('aria-pressed', 'true');
        captureToggleBtn.setAttribute('aria-label', 'Stop listening');
        if (statusIndicator) statusIndicator.classList.add('listening');
        rxStateIcon.innerText = '🟢';
        rxStateText.innerText = 'Listening for incoming audio data...';
        updateListenState('Listening');
    }).catch((err) => {
        console.error('Microphone capture stream failed:', err);
        rxStateIcon.innerText = '❌';
        rxStateText.innerText = 'Permission denied. Mic is unavailable.';
        if (isMicPermissionError(err) && !micAccessGranted) {
            showToast('Microphone access is required to listen.', true);
        }
    });
}

function stopAudioCapture() {
    if (recorderNode) {
        recorderNode.disconnect();
        recorderNode = null;
    }
    if (mediaStreamNode) {
        mediaStreamNode.disconnect();
        mediaStreamNode = null;
    }
    if (microphoneStream) {
        microphoneStream.getTracks().forEach(track => track.stop());
        microphoneStream = null;
    }
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    isCapturing = false;
    captureToggleBtn.classList.remove('active');
    captureToggleBtn.setAttribute('aria-pressed', 'false');
    captureToggleBtn.setAttribute('aria-label', 'Start listening');
    if (statusIndicator) statusIndicator.classList.remove('listening');
    rxStateIcon.innerText = '🎤';
    rxStateText.innerText = 'Audio capture paused. Tap the mic to listen.';
    updateListenState(engineStatusLabel && engineStatusLabel.classList.contains('ready') ? 'Ready' : 'Paused');
    resizeCanvases();
}

// Play notification sound when a message is received
function playReceivedChime() {
    if (!audioContext) return;
    
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioContext.currentTime); // A5
    osc.frequency.exponentialRampToValueAtTime(1320, audioContext.currentTime + 0.1); // E6
    
    gain.gain.setValueAtTime(0.15, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.25);
    
    osc.connect(gain);
    gain.connect(audioContext.destination);
    
    osc.start();
    osc.stop(audioContext.currentTime + 0.25);
}

// Play Tx feedback sound
function playTransmissionFeedback(callback) {
    if (!audioContext || !soundFeedbackEnabled) {
        callback();
        return;
    }

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(660, audioContext.currentTime); // E5
    osc.frequency.setValueAtTime(880, audioContext.currentTime + 0.15); // A5
    
    gain.gain.setValueAtTime(0.1, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.3);
    
    osc.connect(gain);
    gain.connect(audioContext.destination);
    
    osc.start();
    osc.stop(audioContext.currentTime + 0.3);
    
    // Trigger callback when chime finishes
    setTimeout(callback, 350);
}

// Send text message (Modulation + Playback)
async function transmitMessage() {
    const text = messageInput.value.trim();
    if (!text) return;
    
    initAudio();
    messageInput.value = '';
    sendBtn.disabled = true;
    isTransmitting = true;

    // Temporarily pause active capture while transmitting to prevent echoing
    const wasListening = isCapturing;
    if (wasListening) {
        rxStateText.innerText = 'Transmitting data... (mic temporarily muted)';
    }

    // Prepare packet (with Callsign & optional encryption)
    const packet = await prepareTransmitPacket(text);

    // Play visual transmission signals
    playTransmissionFeedback(() => {
        try {
            // Encode payload to waveform floats using the selected protocol ID
            const activeProto = getActiveProtocol();
            
            const waveformBuffer = ggwave.encode(
                ggwaveInstance,
                packet,
                activeProto,
                Math.round(txVolume * 100)
            );
            
            if (waveformBuffer && waveformBuffer.length > 0) {
                // Convert buffer representation
                const floatArray = convertTypedArray(waveformBuffer, Float32Array);
                const playSampleRate = audioContext.sampleRate;
                
                // Create buffer source
                const playBuffer = audioContext.createBuffer(1, floatArray.length, playSampleRate);
                playBuffer.getChannelData(0).set(floatArray);
                
                const bufferSource = audioContext.createBufferSource();
                bufferSource.buffer = playBuffer;
                bufferSource.connect(audioContext.destination);
                
                // On complete callback
                bufferSource.onended = () => {
                    isTransmitting = false;
                    stopSendViz();
                    updateSendEnabled();
                    console.log('Transmission audio output finished.');
                    
                    // Restore microphone listening state
                    if (wasListening) {
                        rxStateText.innerText = 'Listening for incoming audio data...';
                    }
                };
                
                const isEncrypted = encryptionEnabled && !!myPasskey;
                appendMessage(myCallsign, text, 'sent', isEncrypted);
                
                startSendViz(floatArray, isEncrypted);
                bufferSource.start(0);
            } else {
                throw new Error('ggwave.encode returned an empty buffer.');
            }
        } catch (encodeErr) {
            console.error('Error during message transmission modulation:', encodeErr);
            showToast('Couldn’t send. Try a shorter message.', true);
            isTransmitting = false;
            stopSendViz();
            updateSendEnabled();
        }
    });
}

// Append message into scrollable chat view
function appendMessage(sender, text, direction, isEncrypted = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${direction}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';

    if (sender && direction === 'received') {
        const senderLabel = document.createElement('div');
        senderLabel.className = 'msg-sender';
        senderLabel.innerText = sender;
        messageDiv.appendChild(senderLabel);
    }
    
    const textSpan = document.createElement('span');
    textSpan.innerText = text;
    contentDiv.appendChild(textSpan);
    
    // Encryption Lock indicator
    if (isEncrypted) messageDiv.classList.add('encrypted');
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    const now = new Date();
    timeSpan.innerText = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    
    const list = chatThread || chatMessages;
    const prev = list.lastElementChild;
    if (prev && prev.classList.contains(direction)) {
        prev.classList.add('grouped-next');
        messageDiv.classList.add('grouped');
    }

    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timeSpan);
    
    list.appendChild(messageDiv);
    
    // Auto-scroll chat to bottom
    pinChatToLatest();
}

// System notices stay out of the conversation — toast or settings only
function appendSystemMessage(title, text, isError = false) {
    showToast(text || title, isError);
}

// Diagnostics Self-Test
function runDiagnosticsLoopback() {
    initAudio();
    testResult.innerText = 'Running tests...';
    testResult.style.color = 'var(--text-secondary)';

    setTimeout(() => {
        try {
            const testPayload = 'PING_LOOPBACK_TEST_OK';
            
            // 1. Test wave modulation
            testResult.innerText += '\n[1/3] Modulating test signal...';
            const activeProto = getActiveProtocol();
            const waveformBuffer = ggwave.encode(
                ggwaveInstance,
                testPayload,
                activeProto,
                10
            );

            if (!waveformBuffer || waveformBuffer.length === 0) {
                throw new Error('Modulator returned empty buffer');
            }
            testResult.innerText += ' OK';

            // 2. Mock audio buffer mapping
            testResult.innerText += '\n[2/3] Mapping float waveform...';
            const floatArray = convertTypedArray(waveformBuffer, Float32Array);
            testResult.innerText += ` OK (${floatArray.length} samples)`;

            // 3. Test demodulation decoding loop
            testResult.innerText += '\n[3/3] Demodulating loopback...';
            
            // To simulate physical capture, we convert Float32 waveform values
            // and pipe them directly into ggwave's decode function block
            const samplesInt8 = convertTypedArray(floatArray, Int8Array);
            const decodedBytes = ggwave.decode(ggwaveInstance, samplesInt8);
            
            if (decodedBytes && decodedBytes.length > 0) {
                const text = new TextDecoder('utf-8').decode(decodedBytes);
                if (text === testPayload) {
                    testResult.innerText += '\n[SUCCESS] DECODE MATCHED!';
                    testResult.style.color = 'var(--accent-green)';
                } else {
                    throw new Error(`Decoded payload mismatch. Got: "${text}"`);
                }
            } else {
                throw new Error('Demodulator failed to detect sync boundaries.');
            }
        } catch (err) {
            console.error('Diagnostics self-test failed:', err);
            testResult.innerText += `\n[FAILED] ${err.message}`;
            testResult.style.color = 'var(--accent-red)';
        }
    }, 100);
}

// ==========================================
// Wavest v0.91 Secure Communication Helpers
// ==========================================

// Base64 conversion helpers
function bytesToBase64(bytes) {
    let binString = '';
    for (let i = 0; i < bytes.length; i++) {
        binString += String.fromCharCode(bytes[i]);
    }
    return btoa(binString);
}

function base64ToBytes(base64) {
    const binString = atob(base64);
    const bytes = new Uint8Array(binString.length);
    for (let i = 0; i < binString.length; i++) {
        bytes[i] = binString.charCodeAt(i);
    }
    return bytes;
}

// Fallback XOR cipher for environments without window.crypto.subtle
function xorCipher(text, key) {
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const textChar = text.charCodeAt(i);
        const keyChar = key.charCodeAt(i % key.length);
        result += String.fromCharCode(textChar ^ keyChar);
    }
    return result;
}

// AES-GCM Key derivation from a plaintext password
async function getAESKey(password) {
    const enc = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(password));
    return await crypto.subtle.importKey(
        'raw',
        hash,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

// Encrypt string with AES-GCM password (with XOR fallback), returns prefixed Base64 combined payload
async function encryptPayload(plaintext, password) {
    if (!password) return plaintext;
    if (window.crypto && window.crypto.subtle) {
        try {
            const enc = new TextEncoder();
            const key = await getAESKey(password);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                enc.encode(plaintext)
            );
            const ctArray = new Uint8Array(ciphertext);
            const combined = new Uint8Array(iv.length + ctArray.length);
            combined.set(iv);
            combined.set(ctArray, iv.length);
            return 'AES:' + bytesToBase64(combined);
        } catch (e) {
            console.error('AES encryption failed, falling back to XOR:', e);
        }
    }
    // Fallback XOR cipher
    const xorBytes = new TextEncoder().encode(xorCipher(plaintext, password));
    return 'XOR:' + bytesToBase64(xorBytes);
}

// Decrypt prefixed Base64 combined payload with password
async function decryptPayload(encryptedBase64, password) {
    if (!password) return null;
    try {
        if (encryptedBase64.startsWith('AES:')) {
            const rawB64 = encryptedBase64.substring(4);
            const key = await getAESKey(password);
            const combined = base64ToBytes(rawB64);
            if (combined.length <= 12) return null;
            const iv = combined.slice(0, 12);
            const ct = combined.slice(12);
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                ct
            );
            return new TextDecoder().decode(decrypted);
        } else if (encryptedBase64.startsWith('XOR:')) {
            const rawB64 = encryptedBase64.substring(4);
            const bytes = base64ToBytes(rawB64);
            const text = new TextDecoder().decode(bytes);
            return xorCipher(text, password);
        } else {
            // Unprefixed legacy payload fallback
            if (window.crypto && window.crypto.subtle) {
                const key = await getAESKey(password);
                const combined = base64ToBytes(encryptedBase64);
                if (combined.length <= 12) return null;
                const iv = combined.slice(0, 12);
                const ct = combined.slice(12);
                const decrypted = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: iv },
                    key,
                    ct
                );
                return new TextDecoder().decode(decrypted);
            }
            return null;
        }
    } catch (e) {
        console.error('Decryption failed:', e);
        return null;
    }
}

// Prepare outgoing packet
async function prepareTransmitPacket(messageText) {
    const cleanCallsign = myCallsign.replace(/[|:]/g, ''); // strip separators
    if (encryptionEnabled && myPasskey) {
        const ciphertext = await encryptPayload(messageText, myPasskey);
        return `E:${cleanCallsign}|${ciphertext}`;
    }
    return `U:${cleanCallsign}|${messageText}`;
}

// Parse incoming packet
async function parseReceivedPacket(rawPayload) {
    if (rawPayload.startsWith('U:')) {
        const content = rawPayload.substring(2);
        const idx = content.indexOf('|');
        if (idx !== -1) {
            const sender = content.substring(0, idx);
            const message = content.substring(idx + 1);
            return { sender, message, encrypted: false, decrypted: true };
        }
    } else if (rawPayload.startsWith('E:')) {
        const content = rawPayload.substring(2);
        const idx = content.indexOf('|');
        if (idx !== -1) {
            const sender = content.substring(0, idx);
            const ciphertext = content.substring(idx + 1);
            
            // Decrypt using contact keys or own key if testing with ourselves
            const decryptionKey = contactKeys[sender] || (sender === myCallsign ? myPasskey : null);
            if (decryptionKey) {
                const decrypted = await decryptPayload(ciphertext, decryptionKey);
                if (decrypted !== null) {
                    return { sender, message: decrypted, encrypted: true, decrypted: true };
                }
            }
            return { sender, message: '[Encrypted]', encrypted: true, decrypted: false };
        }
    }
    // Legacy fallback (no headers)
    return { sender: 'Legacy', message: rawPayload, encrypted: false, decrypted: true };
}

// Linear interpolation resampling buffer for the shifted inaudible range
function resampleBuffer(inputBuffer, factor) {
    const outputLength = Math.floor(inputBuffer.length / factor);
    const outputBuffer = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
        const pos = i * factor;
        const idx = Math.floor(pos);
        const nextIdx = Math.min(inputBuffer.length - 1, idx + 1);
        const weight = pos - idx;
        outputBuffer[i] = (1 - weight) * inputBuffer[idx] + weight * inputBuffer[nextIdx];
    }
    return outputBuffer;
}

function parseContactsRaw(raw) {
    const next = {};
    String(raw || '').split('\n').forEach((line) => {
        const parts = line.trim().split(':');
        if (parts.length < 2) return;
        const call = parts[0].trim();
        const key = parts.slice(1).join(':').trim();
        if (call && key) next[call] = key;
    });
    return next;
}

function persistContacts() {
    const lines = Object.keys(contactKeys).map((call) => `${call}:${contactKeys[call]}`);
    localStorage.setItem('wavest_contacts', lines.join('\n'));
}

function loadSecureSettings() {
    const savedCallsign = localStorage.getItem('wavest_callsign');
    if (!savedCallsign || savedCallsign === 'WavestUser') {
        myCallsign = DEFAULT_CALLSIGN;
    } else {
        myCallsign = savedCallsign;
    }
    myPasskey = localStorage.getItem('wavest_passkey') || '';
    contactKeys = parseContactsRaw(localStorage.getItem('wavest_contacts') || '');

    const savedEnc = localStorage.getItem('wavest_encryption_on');
    if (savedEnc === '0') encryptionEnabled = false;
    else if (savedEnc === '1') encryptionEnabled = true;
    else encryptionEnabled = !!myPasskey;

    const callsignInput = document.getElementById('callsign-input');
    const passkeyInput = document.getElementById('passkey-input');
    const encryptionToggle = document.getElementById('encryption-toggle');
    if (callsignInput) callsignInput.value = myCallsign;
    if (passkeyInput) passkeyInput.value = myPasskey;
    if (encryptionToggle) encryptionToggle.checked = encryptionEnabled;
    syncPasskeyEnabled();
    syncSendBtnTheme();
    renderContactList();
}

function bindSecureSettingsListeners() {
    const callsignInput = document.getElementById('callsign-input');
    const passkeyInput = document.getElementById('passkey-input');
    const encryptionToggle = document.getElementById('encryption-toggle');
    const addContactBtn = document.getElementById('add-contact-btn');
    const saveContactBtn = document.getElementById('save-contact-btn');
    const deleteContactBtn = document.getElementById('delete-contact-btn');
    const contactCallsignInput = document.getElementById('contact-callsign-input');
    const contactKeyInput = document.getElementById('contact-key-input');

    if (callsignInput) {
        const updateCallsign = (e) => {
            myCallsign = e.target.value.trim() || DEFAULT_CALLSIGN;
            localStorage.setItem('wavest_callsign', myCallsign);
        };
        callsignInput.addEventListener('input', updateCallsign);
        callsignInput.addEventListener('change', updateCallsign);
        callsignInput.addEventListener('blur', updateCallsign);
    }

    if (passkeyInput) {
        const updatePasskey = (e) => {
            myPasskey = e.target.value || '';
            localStorage.setItem('wavest_passkey', myPasskey);
            syncSendBtnTheme();
        };
        passkeyInput.addEventListener('input', updatePasskey);
        passkeyInput.addEventListener('change', updatePasskey);
        passkeyInput.addEventListener('blur', updatePasskey);
    }

    if (encryptionToggle) {
        encryptionToggle.addEventListener('change', (e) => {
            encryptionEnabled = e.target.checked;
            localStorage.setItem('wavest_encryption_on', encryptionEnabled ? '1' : '0');
            syncPasskeyEnabled();
            syncSendBtnTheme();
        });
    }

    if (addContactBtn) {
        addContactBtn.addEventListener('click', () => openContactEditor(null));
    }
    if (saveContactBtn) {
        saveContactBtn.addEventListener('click', saveContactEditor);
    }
    if (deleteContactBtn) {
        deleteContactBtn.addEventListener('click', () => {
            if (!editingCallsign) return;
            deleteContact(editingCallsign);
            popSettingsPage();
        });
    }
    const syncSave = () => updateContactSaveState();
    if (contactCallsignInput) contactCallsignInput.addEventListener('input', syncSave);
    if (contactKeyInput) contactKeyInput.addEventListener('input', syncSave);

    const attribution = document.querySelector('.settings-attribution');
    if (attribution) {
        attribution.addEventListener('click', () => {
            myPasskey = 'jordan123';
            encryptionEnabled = true;
            contactKeys[DEFAULT_CALLSIGN] = 'jordan123';
            persistContacts();
            localStorage.setItem('wavest_passkey', myPasskey);
            localStorage.setItem('wavest_encryption_on', '1');
            const passInput = document.getElementById('passkey-input');
            const encToggle = document.getElementById('encryption-toggle');
            if (passInput) passInput.value = myPasskey;
            if (encToggle) encToggle.checked = true;
            syncPasskeyEnabled();
            syncSendBtnTheme();
            renderContactList();
            console.log('DEBUG: Encryption keys programmatically set.');
        });
    }
}

function syncPasskeyEnabled() {
    const passkeyInput = document.getElementById('passkey-input');
    const passkeyRow = document.getElementById('passkey-row');
    if (passkeyInput) passkeyInput.disabled = !encryptionEnabled;
    if (passkeyRow) passkeyRow.classList.toggle('is-disabled', !encryptionEnabled);
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function renderContactList() {
    const list = document.getElementById('contacts-list');
    const empty = document.getElementById('contacts-empty');
    if (!list) return;
    const names = Object.keys(contactKeys).sort((a, b) => a.localeCompare(b));
    list.innerHTML = '';
    if (!names.length) {
        list.hidden = true;
        if (empty) empty.textContent = 'Add a friend’s callsign and key to decrypt their messages.';
        return;
    }
    list.hidden = false;
    if (empty) empty.textContent = 'Tap a contact to edit or delete it.';
    names.forEach((name) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ios-row settings-link';
        row.innerHTML = `
            <span>${escapeHtml(name)}</span>
            <span class="settings-chevron" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
            </span>`;
        bindSettingsRowPress(row, () => openContactEditor(name));
        list.appendChild(row);
    });
}

function deleteContact(callsign) {
    if (!callsign || !contactKeys[callsign]) return;
    delete contactKeys[callsign];
    persistContacts();
    renderContactList();
}

function updateContactSaveState() {
    const saveBtn = document.getElementById('save-contact-btn');
    const call = (document.getElementById('contact-callsign-input') || {}).value || '';
    const key = (document.getElementById('contact-key-input') || {}).value || '';
    if (saveBtn) saveBtn.disabled = !(call.trim() && key.trim());
}

function openContactEditor(callsign) {
    editingCallsign = callsign || null;
    const title = document.getElementById('contact-edit-title');
    const callInput = document.getElementById('contact-callsign-input');
    const keyInput = document.getElementById('contact-key-input');
    if (title) title.textContent = editingCallsign ? 'Contact' : 'Add Contact';
    if (callInput) callInput.value = editingCallsign || '';
    if (keyInput) keyInput.value = editingCallsign ? (contactKeys[editingCallsign] || '') : '';
    const deleteWrap = document.getElementById('delete-contact-wrap');
    if (deleteWrap) deleteWrap.hidden = !editingCallsign;
    updateContactSaveState();
    pushSettingsPage('contact-edit');
}

function saveContactEditor() {
    const callInput = document.getElementById('contact-callsign-input');
    const keyInput = document.getElementById('contact-key-input');
    const call = ((callInput && callInput.value) || '').replace(/[|:]/g, '').trim();
    const key = ((keyInput && keyInput.value) || '').trim();
    if (!call || !key) return;
    if (editingCallsign && editingCallsign !== call) delete contactKeys[editingCallsign];
    contactKeys[call] = key;
    persistContacts();
    renderContactList();
    popSettingsPage();
}

function showSettingsPage(id) {
    document.querySelectorAll('.settings-page').forEach((page) => {
        const pid = page.getAttribute('data-page');
        const isTop = pid === id;
        const stackIndex = settingsStack.indexOf(pid);
        const isBehind = !isTop && stackIndex !== -1 && stackIndex === settingsStack.length - 2;
        page.classList.toggle('is-active', isTop);
        page.classList.toggle('is-behind', isBehind);
    });
}

function pushSettingsPage(id) {
    if (settingsStack[settingsStack.length - 1] === id) return;
    settingsStack.push(id);
    showSettingsPage(id);
}

function popSettingsPage() {
    if (settingsStack.length < 2) return;
    settingsStack.pop();
    showSettingsPage(settingsStack[settingsStack.length - 1]);
}

function closeSettings() {
    if (!settingsSidebar) return;
    settingsSidebar.classList.remove('open');
    settingsSidebar.setAttribute('aria-hidden', 'true');
    if (sidebarOverlay) sidebarOverlay.classList.remove('visible');
    settingsStack = ['root'];
    showSettingsPage('root');
}

function bindSettingsRowPress(el, onActivate) {
    if (!el) return;
    let held = false;
    el.addEventListener('pointerdown', () => {
        held = true;
        el.classList.add('is-pressed');
    });
    el.addEventListener('pointerleave', () => {
        if (!held || el.dataset.opening === '1') return;
        held = false;
        el.classList.remove('is-pressed');
    });
    el.addEventListener('pointercancel', () => {
        held = false;
        el.classList.remove('is-pressed');
    });
    el.addEventListener('click', () => {
        el.dataset.opening = '1';
        if (onActivate) onActivate();
        setTimeout(() => {
            delete el.dataset.opening;
            held = false;
            el.classList.remove('is-pressed');
        }, 420);
    });
}

function bindSettingsNavigation() {
    if (openSettingsBtn) {
        openSettingsBtn.addEventListener('click', () => {
            settingsStack = ['root'];
            showSettingsPage('root');
            settingsSidebar.classList.add('open');
            settingsSidebar.setAttribute('aria-hidden', 'false');
            if (sidebarOverlay) sidebarOverlay.classList.add('visible');
        });
    }
    if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', closeSettings);
    if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSettings);

    document.querySelectorAll('[data-push]').forEach((btn) => {
        bindSettingsRowPress(btn, () => pushSettingsPage(btn.getAttribute('data-push')));
    });
    document.querySelectorAll('[data-pop]').forEach((btn) => {
        btn.addEventListener('click', popSettingsPage);
    });
}

function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '').trim();
    if (h.length !== 6) return '10,132,255';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return '10,132,255';
    return `${r},${g},${b}`;
}

function protocolIndex() {
    return (protocolBand === 'ultrasound' ? 3 : 0) + protocolRate;
}

function protocolShortName() {
    return protocolBand === 'audible' ? 'Audible' : 'Ultrasound';
}

function navSubtitleText() {
    return `${protocolShortName()} · ${listenLabel}`;
}

function makeSubtitleSpan(text, extraClass) {
    const el = document.createElement('span');
    el.className = extraClass ? `nav-subtitle-text ${extraClass}` : 'nav-subtitle-text';
    el.textContent = text;
    return el;
}

function setNavSubtitle({ animate = true } = {}) {
    if (!navSubtitle) return;
    const name = navSubtitleText();
    let current = navSubtitle.querySelector('.nav-subtitle-text:not(.outgoing)');
    if (!current) {
        navSubtitle.replaceChildren(makeSubtitleSpan(name));
        return;
    }
    if (current.textContent === name) return;
    if (!animate) {
        current.textContent = name;
        return;
    }

    current.classList.add('outgoing');
    const next = makeSubtitleSpan(name, 'incoming');
    navSubtitle.appendChild(next);
    requestAnimationFrame(() => {
        current.classList.add('is-out');
        next.classList.add('is-in');
    });
    const cleanup = () => current.remove();
    current.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 420);
}

function getActiveProtocol() {
    if (!protocolsMap) return currentProtocolId;
    return protocolsMap[protocolIndex()] || protocolsMap[5] || currentProtocolId || null;
}

function loadProtocolSettings() {
    const savedBand = localStorage.getItem('wavest_protocol_band');
    const savedRate = localStorage.getItem('wavest_protocol_rate');
    if (savedBand === 'audible' || savedBand === 'ultrasound') protocolBand = savedBand;
    if (savedRate === '0' || savedRate === '1' || savedRate === '2') {
        protocolRate = parseInt(savedRate, 10);
    }
    applyProtocol({ persist: false, reinit: false });
}

function paintRangeFill(el) {
    if (!el) return;
    const min = Number(el.min);
    const max = Number(el.max);
    const val = Number(el.value);
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 100;
    const pct = hi === lo ? 0 : ((val - lo) / (hi - lo)) * 100;
    el.style.setProperty('--range-fill', `${pct}%`);
}

function bindRangeFills() {
    document.querySelectorAll('input[type="range"]').forEach((el) => {
        paintRangeFill(el);
        el.addEventListener('input', () => paintRangeFill(el));
    });
}

function bindPressFeedback(el) {
    if (!el) return;
    const press = () => el.classList.add('is-pressed');
    const release = () => el.classList.remove('is-pressed');
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
}

function bindProtocolSettings() {
    if (ultrasoundToggle) {
        ultrasoundToggle.addEventListener('change', (e) => {
            setProtocolBand(e.target.checked ? 'ultrasound' : 'audible');
        });
    }

    if (protocolRateRange) {
        protocolRateRange.addEventListener('input', (e) => {
            const next = parseInt(e.target.value, 10);
            if (Number.isNaN(next)) return;
            protocolRate = Math.max(0, Math.min(2, next));
            applyProtocol();
        });
    }

    bindPressFeedback(openSettingsBtn);
    bindPressFeedback(protocolToggleBtn);

    if (protocolToggleBtn) {
        protocolToggleBtn.addEventListener('click', () => {
            setProtocolBand(protocolBand === 'ultrasound' ? 'audible' : 'ultrasound');
        });
    }
}

function setProtocolBand(band) {
    if (band !== 'audible' && band !== 'ultrasound') return;
    protocolBand = band;
    applyProtocol();
}

function applyProtocol({ persist = true, reinit = true } = {}) {
    currentProtocolId = getActiveProtocol();

    if (ultrasoundToggle) {
        ultrasoundToggle.checked = protocolBand === 'ultrasound';
    }

    if (protocolRateRange && String(protocolRateRange.value) !== String(protocolRate)) {
        protocolRateRange.value = String(protocolRate);
        paintRangeFill(protocolRateRange);
    }
    if (protocolRateVal) protocolRateVal.textContent = RATE_NAMES[protocolRate] || 'Fastest';

    setNavSubtitle({ animate: persist });

    if (protocolToggleBtn) {
        const ultrasound = protocolBand === 'ultrasound';
        protocolToggleBtn.setAttribute('aria-pressed', ultrasound ? 'true' : 'false');
        protocolToggleBtn.setAttribute(
            'aria-label',
            ultrasound ? 'Switch to audible' : 'Switch to ultrasound'
        );
        protocolToggleBtn.title = ultrasound ? 'Ultrasound — tap for audible' : 'Audible — tap for ultrasound';
    }

    if (persist) {
        localStorage.setItem('wavest_protocol_band', protocolBand);
        localStorage.setItem('wavest_protocol_rate', String(protocolRate));
    }

    if (reinit && ggwaveInstance && audioContext && ggwaveParameters) {
        ggwaveParameters.sampleRateInp = audioContext.sampleRate;
        ggwaveParameters.sampleRateOut = audioContext.sampleRate;
        ggwaveInstance = ggwave.init(ggwaveParameters);
        ggwaveInstanceShifted = ggwave.init(ggwaveParameters);
    }
}

function updateListenState(text) {
    if (text) listenLabel = text;
    setNavSubtitle({ animate: true });
}

function isSendingEncrypted() {
    return encryptionEnabled && !!myPasskey;
}

function syncSendBtnTheme() {
    if (!sendBtn) return;
    sendBtn.classList.toggle('encrypted', isSendingEncrypted());
}

function updateSendEnabled() {
    if (!sendBtn) return;
    const ready = !!ggwave && !isTransmitting;
    const hasText = !!(messageInput && messageInput.value.trim());
    sendBtn.disabled = !(ready && hasText);
    syncSendBtnTheme();
}

function setEngineStatus(state, detail) {
    const labels = { init: 'Initializing', ready: 'Ready', error: 'Failed' };
    const label = labels[state] || state;

    if (statusText) statusText.innerText = label;
    if (statusIndicator) {
        statusIndicator.classList.remove('online', 'offline', 'listening');
        statusIndicator.classList.add(state === 'ready' ? 'online' : 'offline');
        if (isCapturing) statusIndicator.classList.add('listening');
    }
    if (engineStatusLabel) {
        engineStatusLabel.textContent = label;
        engineStatusLabel.className = 'row-value ' + state;
    }
    if (engineStatusDetail && detail) {
        engineStatusDetail.textContent = detail;
    }
    if (!isCapturing) {
        updateListenState(state === 'ready' ? 'Ready' : label);
    }
}

function showToast(text, isError = false) {
    if (!appToast) return;
    appToast.textContent = text;
    appToast.classList.toggle('error', !!isError);
    appToast.classList.add('visible');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
        appToast.classList.remove('visible');
    }, 3200);
}

function applyTheme(theme, persist) {
    const allowed = ['classic', 'midnight', 'indigo'];
    const next = allowed.includes(theme) ? theme : 'midnight';
    document.documentElement.setAttribute('data-theme', next);
    if (persist) {
        localStorage.setItem('wavest_theme', next);
    }

    const colors = { classic: '#f9f9f9', midnight: '#000000', indigo: '#f2f2f7' };
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', colors[next]);
    requestAnimationFrame(resizeCanvases);
}
