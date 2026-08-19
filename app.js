// Web Audio API Global instances
let audioContext = null;
let microphoneStream = null;
let mediaStreamNode = null;
let analyserNode = null;
let recorderNode = null;
let recorderSilentGain = null;
let recorderDummyDest = null;
let captureWorkletNode = null;
let captureWorkletLoaded = false;

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
let rxDuringTx = false;
let rxDebugTimer = null;
let rxDebug = {
    backend: 'idle',
    buffers: 0,
    windowBuffers: 0,
    buffersPerSec: 0,
    rms: 0,
    hits: 0,
    lastPayload: '—'
};

// Secure Communication State
let myCallsign = 'WavestUser';
let myPasskey = '';
let contactKeys = {};

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
const activeProtocolLbl = document.getElementById('active-protocol-lbl');

// Send spectrogram (decorative, transmit-only)
const sendVizCanvas = document.getElementById('send-viz-canvas');
const sendVizCtx = sendVizCanvas ? sendVizCanvas.getContext('2d') : null;

// Settings Sidebar DOM
const settingsSidebar = document.getElementById('settings-sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const openSettingsBtn = document.getElementById('open-settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const protocolSelect = document.getElementById('protocol-select');
const volumeRange = document.getElementById('volume-range');
const volumeVal = document.getElementById('volume-val');
const sensitivityRange = document.getElementById('sensitivity-range');
const sensitivityVal = document.getElementById('sensitivity-val');
const soundFeedbackToggle = document.getElementById('sound-feedback-toggle');
const loopbackTestBtn = document.getElementById('loopback-test-btn');
const testResult = document.getElementById('test-result');
const clearChatBtn = document.getElementById('clear-chat-btn');
const navListenState = document.getElementById('nav-listen-state');
const engineStatusLabel = document.getElementById('engine-status-label');
const engineStatusDetail = document.getElementById('engine-status-detail');
const appToast = document.getElementById('app-toast');

// Instantiate ggwave on page load
window.addEventListener('DOMContentLoaded', () => {
    // Resize canvases to fit wrappers
    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);

    applyTheme('midnight', false);
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

function resizeCanvases() {
    if (!sendVizCanvas || !sendVizCtx) return;
    const parent = sendVizCanvas.parentElement;
    const w = parent ? parent.clientWidth : 300;
    const h = sendVizCanvas.clientHeight || 220;
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

    // Settings Sidebar
    openSettingsBtn.addEventListener('click', () => {
        settingsSidebar.classList.add('open');
        settingsSidebar.setAttribute('aria-hidden', 'false');
        sidebarOverlay.classList.add('visible');
    });
    const closeSidebar = () => {
        settingsSidebar.classList.remove('open');
        settingsSidebar.setAttribute('aria-hidden', 'true');
        sidebarOverlay.classList.remove('visible');
    };
    closeSettingsBtn.addEventListener('click', closeSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);

    if (messageInput) {
        messageInput.addEventListener('input', updateSendEnabled);
    }

    // Load secure settings on startup
    loadSecureSettings();
    bindSecureSettingsListeners();

    // Settings Inputs Binding
    protocolSelect.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (protocolsMap && protocolsMap[val] !== undefined) {
            currentProtocolId = protocolsMap[val];
        }
        if (activeProtocolLbl) {
            activeProtocolLbl.innerText = protocolShortName();
        }
    });

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

    const rxDuringTxToggle = document.getElementById('rx-during-tx-toggle');
    if (rxDuringTxToggle) {
        rxDuringTxToggle.addEventListener('change', (e) => {
            rxDuringTx = e.target.checked;
        });
    }

    loopbackTestBtn.addEventListener('click', runDiagnosticsLoopback);

    clearChatBtn.addEventListener('click', () => {
        chatMessages.innerHTML = '';
        closeSidebar();
    });
}

function sendVizBand(sampleRate, windowSize) {
    const proto = protocolSelect ? parseInt(protocolSelect.value, 10) : 5;
    const high = proto >= 3;
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

function startSendViz(floatArray) {
    if (!sendVizCanvas || !sendVizCtx || !audioContext) return;
    resizeCanvases();
    sendVizCtx.clearRect(0, 0, sendVizCanvas.width, sendVizCanvas.height);
    sendVizCanvas.classList.add('active');

    const windowSize = 512;
    const columns = 36;
    const mags = new Float32Array(columns);
    const smoothed = new Float32Array(columns);
    const band = sendVizBand(audioContext.sampleRate, windowSize);
    const txStartTime = audioContext.currentTime;
    const bubbleHex = cssVar('--bubble-sent', '#0a84ff');
    const rgb = hexToRgb(bubbleHex);

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
        // Bloom neighboring bins so tones read as a wash, not spikes
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

// Initialize audio session elements
function applyGgwaveAudioParams(params) {
    params.sampleRateInp = audioContext.sampleRate;
    params.sampleRateOut = audioContext.sampleRate;
    const formats = ggwave.SampleFormat || {};
    const f32 = formats.GGWAVE_SAMPLE_FORMAT_F32;
    if (f32 !== undefined) {
        params.sampleFormatInp = f32;
        params.sampleFormatOut = f32;
    }
}

function enableAllRxProtocols(instance) {
    if (!ggwave || instance == null) return;
    const toggle = ggwave.rxToggleProtocol || ggwave.toggleRxProtocol;
    if (typeof toggle !== 'function' || !protocolsMap) return;
    Object.keys(protocolsMap).forEach((key) => {
        try {
            toggle(instance, protocolsMap[key], true);
        } catch (err) {}
    });
}

function createGgwaveInstance() {
    ggwaveParameters = ggwave.getDefaultParameters();
    applyGgwaveAudioParams(ggwaveParameters);
    const instance = ggwave.init(ggwaveParameters);
    enableAllRxProtocols(instance);
    return instance;
}

function initAudio() {
    if (!ggwave) return;
    if (!audioContext) {
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext({ sampleRate: 48000 });
        ggwaveInstance = createGgwaveInstance();
        ggwaveInstanceShifted = createGgwaveInstance();
        console.log(`Audio Context initialized. Sample Rate: ${audioContext.sampleRate} Hz`);
    }
}

// Audio capture toggle (Listening toggle)
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

async function queryMicPermission() {
    try {
        if (navigator.permissions && navigator.permissions.query) {
            const status = await navigator.permissions.query({ name: 'microphone' });
            return status.state;
        }
    } catch (err) {
        // Safari / some WebViews don't implement microphone permission queries
    }
    return micAccessGranted ? 'granted' : 'unknown';
}

function requestMicrophone(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints);
}

function dispatchDecodedPayload(bytes) {
    try {
        let rawText = '';
        if (typeof bytes === 'string') {
            rawText = bytes;
        } else if (bytes && bytes.length > 0) {
            const copy = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) {
                copy[i] = bytes[i] & 0xff;
            }
            rawText = new TextDecoder('utf-8').decode(copy);
        }
        if (!rawText) return;
        rxDebug.lastPayload = rawText;
        updateRxDebugUI();
        console.log('Successfully decoded raw sonic payload:', rawText);
        parseReceivedPacket(rawText).then((parsed) => {
            appendMessage(parsed.sender, parsed.message, 'received', parsed.encrypted);
            playReceivedChime();
        }).catch((parseErr) => {
            console.error('Parsing received packet failed:', parseErr);
        });
    } catch (decodeErr) {
        console.error('Decoding text payload failed:', decodeErr);
    }
}

function updateRxDebugUI() {
    const levelVal = document.getElementById('rx-debug-level-val');
    const levelBar = document.getElementById('rx-debug-level-bar');
    const captureEl = document.getElementById('rx-debug-capture');
    const hitsEl = document.getElementById('rx-debug-hits');
    const payloadEl = document.getElementById('rx-debug-payload');
    const pct = Math.min(100, Math.round(rxDebug.rms * 400));
    if (levelVal) levelVal.textContent = pct + '%';
    if (levelBar) levelBar.style.width = pct + '%';
    if (captureEl) {
        if (!isCapturing) {
            captureEl.textContent = 'Idle';
        } else {
            const rate = audioContext ? Math.round(audioContext.sampleRate) : 0;
            captureEl.textContent = rxDebug.buffersPerSec + '/s · ' + rxDebug.backend + ' · ' + rate + ' Hz';
        }
    }
    if (hitsEl) hitsEl.textContent = String(rxDebug.hits);
    if (payloadEl) payloadEl.textContent = rxDebug.lastPayload;
}

function startRxDebugTimer() {
    if (rxDebugTimer) clearInterval(rxDebugTimer);
    rxDebug.windowBuffers = 0;
    rxDebugTimer = setInterval(() => {
        rxDebug.buffersPerSec = rxDebug.windowBuffers;
        rxDebug.windowBuffers = 0;
        updateRxDebugUI();
    }, 1000);
    updateRxDebugUI();
}

function stopRxDebugTimer() {
    if (rxDebugTimer) {
        clearInterval(rxDebugTimer);
        rxDebugTimer = null;
    }
    rxDebug.backend = 'idle';
    rxDebug.buffersPerSec = 0;
    rxDebug.rms = 0;
    updateRxDebugUI();
}

function feedCaptureSamples(input) {
    if (!input || !input.length) return;

    const samples = new Float32Array(input.length);
    let sum = 0;
    const gain = rxGain;
    for (let i = 0; i < input.length; i++) {
        const v = input[i] * gain;
        samples[i] = v;
        sum += v * v;
    }
    rxDebug.rms = Math.sqrt(sum / input.length);
    rxDebug.buffers += 1;
    rxDebug.windowBuffers += 1;

    const skipDecode = isTransmitting && !rxDuringTx;
    if (skipDecode || !ggwave || !ggwaveInstance) {
        updateRxDebugUI();
        return;
    }

    const decodedBytes = ggwave.decode(
        ggwaveInstance,
        convertTypedArray(samples, Int8Array)
    );
    if (decodedBytes && decodedBytes.length > 0) {
        rxDebug.hits += 1;
        dispatchDecodedPayload(decodedBytes);
    }
    updateRxDebugUI();
}

function keepCaptureNodeAlive(node) {
    recorderDummyDest = audioContext.createMediaStreamDestination();
    node.connect(recorderDummyDest);
    // A fully muted node can be skipped by the audio graph. A tiny tap
    // keeps ScriptProcessor/AudioWorklet running without speaker echo.
    recorderSilentGain = audioContext.createGain();
    recorderSilentGain.gain.value = 0.001;
    node.connect(recorderSilentGain);
    recorderSilentGain.connect(audioContext.destination);
}

async function startCaptureProcessor(sourceNode) {
    if (!audioContext.audioWorklet) {
        throw new Error('AudioWorklet is not available');
    }
    const workletSource = `
        class CaptureProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this._buf = new Float32Array(1024);
                this._off = 0;
            }
            process(inputs) {
                const channel = (inputs[0] && inputs[0][0]) || null;
                const n = channel ? channel.length : 128;
                for (let i = 0; i < n; i++) {
                    this._buf[this._off++] = channel ? channel[i] : 0;
                    if (this._off >= this._buf.length) {
                        this.port.postMessage(this._buf.slice());
                        this._off = 0;
                    }
                }
                return true;
            }
        }
        registerProcessor('wavest-capture', CaptureProcessor);
    `;
    if (!captureWorkletLoaded) {
        const blob = new Blob([workletSource], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        try {
            await audioContext.audioWorklet.addModule(url);
            captureWorkletLoaded = true;
        } finally {
            URL.revokeObjectURL(url);
        }
    }
    captureWorkletNode = new AudioWorkletNode(audioContext, 'wavest-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
    });
    captureWorkletNode.port.onmessage = (event) => {
        feedCaptureSamples(event.data);
    };
    sourceNode.connect(captureWorkletNode);
    keepCaptureNodeAlive(captureWorkletNode);
    rxDebug.backend = 'AudioWorklet';
}

function startScriptProcessorCapture(sourceNode) {
    const bufferSize = 1024;
    if (audioContext.createScriptProcessor) {
        recorderNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
    } else {
        recorderNode = audioContext.createJavaScriptNode(bufferSize, 1, 1);
    }
    recorderNode.onaudioprocess = (e) => {
        feedCaptureSamples(e.inputBuffer.getChannelData(0));
    };
    sourceNode.connect(recorderNode);
    keepCaptureNodeAlive(recorderNode);
    rxDebug.backend = 'ScriptProcessor';
}

// Start microphone pipeline
async function startAudioCapture() {
    if (!audioContext || !ggwave) return;

    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    const constraints = {
        audio: {
            channelCount: 1,
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: false,
            voiceIsolation: false,
            googEchoCancellation: false,
            googAutoGainControl: false,
            googNoiseSuppression: false,
            googHighpassFilter: false
        }
    };

    const permissionState = await queryMicPermission();

    const onStream = (stream) => {
        micAccessGranted = true;
        localStorage.setItem('wavest_mic_granted', '1');
        microphoneStream = stream;
        mediaStreamNode = audioContext.createMediaStreamSource(stream);
        
        analyserNode = audioContext.createAnalyser();
        mediaStreamNode.connect(analyserNode);

        // Fresh decoder so leftover TX state cannot block RX
        try {
            ggwaveInstance = createGgwaveInstance();
        } catch (err) {
            console.error('Failed to recreate ggwave RX instance:', err);
        }

        const onGraphReady = () => {
            isCapturing = true;
            captureToggleBtn.classList.add('active');
            captureToggleBtn.setAttribute('aria-pressed', 'true');
            captureToggleBtn.setAttribute('aria-label', 'Stop listening');
            if (statusIndicator) statusIndicator.classList.add('listening');
            rxStateIcon.innerText = '🟢';
            rxStateText.innerText = 'Listening for incoming audio data...';
            updateListenState('Listening');
            startRxDebugTimer();
        };

        try {
            startScriptProcessorCapture(mediaStreamNode);
            onGraphReady();
        } catch (err) {
            console.error('ScriptProcessor capture failed, trying AudioWorklet:', err);
            startCaptureProcessor(mediaStreamNode).then(onGraphReady).catch((workletErr) => {
                console.error('Audio capture processor failed:', workletErr);
                rxStateText.innerText = 'Could not start audio capture.';
            });
        }
    };

    const onMicError = async (err) => {
        const alreadyAllowed = permissionState === 'granted' || micAccessGranted;
        if (alreadyAllowed) {
            try {
                const stream = await requestMicrophone(constraints);
                onStream(stream);
                return;
            } catch (retryErr) {
                console.error('Microphone capture retry failed:', retryErr);
                rxStateIcon.innerText = '❌';
                rxStateText.innerText = 'Microphone is busy. Try again.';
                return;
            }
        }

        console.error('Microphone capture stream failed:', err);
        rxStateIcon.innerText = '❌';
        if (isMicPermissionError(err)) {
            rxStateText.innerText = 'Permission denied. Mic is unavailable.';
            showToast('Microphone access is required to listen.', true);
        } else {
            rxStateText.innerText = 'Could not start the microphone.';
        }
    };

    requestMicrophone(constraints).then(onStream).catch(onMicError);
}

// Stop microphone capture
function stopAudioCapture() {
    if (captureWorkletNode) {
        try { captureWorkletNode.port.onmessage = null; } catch (err) {}
        captureWorkletNode.disconnect();
        captureWorkletNode = null;
    }
    if (recorderNode) {
        recorderNode.onaudioprocess = null;
        recorderNode.disconnect();
        recorderNode = null;
    }
    if (recorderSilentGain) {
        recorderSilentGain.disconnect();
        recorderSilentGain = null;
    }
    if (recorderDummyDest) {
        recorderDummyDest.disconnect();
        recorderDummyDest = null;
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
    stopRxDebugTimer();
    
    // Clear visualization traces
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
                
                // If protocol is inaudible, shift sample rate up by 1.0867
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
                
                // Display message in chat feed
                const isEncrypted = !!myPasskey;
                appendMessage(myCallsign, text, 'sent', isEncrypted);
                
                startSendViz(floatArray);
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
    if (isEncrypted) {
        const lockIcon = document.createElement('span');
        lockIcon.className = 'msg-lock';
        lockIcon.innerText = '🔒';
        contentDiv.appendChild(lockIcon);
    }
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    const now = new Date();
    timeSpan.innerText = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    
    const prev = chatMessages.lastElementChild;
    if (prev && prev.classList.contains(direction)) {
        prev.classList.add('grouped-next');
        messageDiv.classList.add('grouped');
    }

    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timeSpan);
    
    chatMessages.appendChild(messageDiv);
    
    // Auto-scroll chat to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
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
    if (myPasskey) {
        const ciphertext = await encryptPayload(messageText, myPasskey);
        return `E:${cleanCallsign}|${ciphertext}`;
    } else {
        return `U:${cleanCallsign}|${messageText}`;
    }
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
            return { sender, message: '[Encrypted Message - Key Required]', encrypted: true, decrypted: false };
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

// Load secure settings from localStorage
function loadSecureSettings() {
    myCallsign = localStorage.getItem('wavest_callsign') || 'WavestUser';
    myPasskey = localStorage.getItem('wavest_passkey') || '';
    const contactsRaw = localStorage.getItem('wavest_contacts') || '';
    
    // Parse contacts (Callsign:Key, one per line)
    contactKeys = {};
    const lines = contactsRaw.split('\n');
    for (const line of lines) {
        const parts = line.trim().split(':');
        if (parts.length >= 2) {
            const call = parts[0].trim();
            const key = parts.slice(1).join(':').trim();
            if (call && key) {
                contactKeys[call] = key;
            }
        }
    }

    // Set values in elements
    const callsignInput = document.getElementById('callsign-input');
    const passkeyInput = document.getElementById('passkey-input');
    const contactsInput = document.getElementById('contacts-input');

    if (callsignInput) callsignInput.value = myCallsign;
    if (passkeyInput) passkeyInput.value = myPasskey;
    if (contactsInput) contactsInput.value = contactsRaw;
}

// Bind secure settings event listeners
function bindSecureSettingsListeners() {
    const callsignInput = document.getElementById('callsign-input');
    const passkeyInput = document.getElementById('passkey-input');
    const contactsInput = document.getElementById('contacts-input');

    if (callsignInput) {
        const updateCallsign = (e) => {
            myCallsign = e.target.value.trim() || 'WavestUser';
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
        };
        passkeyInput.addEventListener('input', updatePasskey);
        passkeyInput.addEventListener('change', updatePasskey);
        passkeyInput.addEventListener('blur', updatePasskey);
    }

    if (contactsInput) {
        const updateContacts = (e) => {
            const val = e.target.value;
            localStorage.setItem('wavest_contacts', val);
            
            contactKeys = {};
            const lines = val.split('\n');
            for (const line of lines) {
                const parts = line.trim().split(':');
                if (parts.length >= 2) {
                    const call = parts[0].trim();
                    const key = parts.slice(1).join(':').trim();
                    if (call && key) {
                        contactKeys[call] = key;
                    }
                }
            }
        };
        contactsInput.addEventListener('input', updateContacts);
        contactsInput.addEventListener('change', updateContacts);
        contactsInput.addEventListener('blur', updateContacts);
    }

    // Programmatic test helper triggered by tapping the version footer
    const attribution = document.querySelector('.settings-attribution');
    if (attribution) {
        attribution.addEventListener('click', () => {
            const passInput = document.getElementById('passkey-input');
            if (passInput) {
                passInput.value = 'jordan123';
                passInput.dispatchEvent(new Event('change'));
            }
            const contactsInput = document.getElementById('contacts-input');
            if (contactsInput) {
                contactsInput.value = 'WavestUser:jordan123';
                contactsInput.dispatchEvent(new Event('change'));
            }
            console.log('DEBUG: Encryption keys programmatically set.');
        });
    }
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

function protocolShortName() {
    if (!protocolSelect || protocolSelect.selectedIndex < 0) return 'Ultrasound';
    return protocolSelect.options[protocolSelect.selectedIndex].text.split(' (')[0];
}

function getActiveProtocol() {
    if (currentProtocolId) return currentProtocolId;
    if (!protocolsMap) return null;
    const val = protocolSelect ? parseInt(protocolSelect.value, 10) : 5;
    return protocolsMap[val] || protocolsMap[5] || null;
}

function updateListenState(text) {
    if (navListenState) navListenState.textContent = text;
}

function updateSendEnabled() {
    if (!sendBtn) return;
    const ready = !!ggwave && !isTransmitting;
    const hasText = !!(messageInput && messageInput.value.trim());
    sendBtn.disabled = !(ready && hasText);
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
