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

// Secure Communication State
let myCallsign = 'WavestUser';
let myPasskey = '';
let contactKeys = {};

// Visualization configuration
let activeVizTab = 'spectrogram'; // 'spectrogram' or 'oscilloscope'
let animationFrameId = null;

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

// Transmit Visualizer DOM
const txWaveWrapper = document.getElementById('tx-wave-wrapper');
const txWaveCanvas = document.getElementById('tx-wave-canvas');
const txWaveCtx = txWaveCanvas ? txWaveCanvas.getContext('2d') : null;

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

// Canvas DOM
const spectrogramCanvas = document.getElementById('spectrogram-canvas');
const spectrogramCtx = spectrogramCanvas.getContext('2d');
const oscilloscopeCanvas = document.getElementById('oscilloscope-canvas');
const oscilloscopeCtx = oscilloscopeCanvas.getContext('2d');

// Instantiate ggwave on page load
window.addEventListener('DOMContentLoaded', () => {
    // Resize canvases to fit wrappers
    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);

    // Initial status
    statusIndicator.className = 'status-dot offline';
    statusText.innerText = 'INITIALIZING ENGINE...';

    // Hook up ggwave factory
    if (typeof ggwave_factory !== 'undefined') {
        ggwave_factory().then((obj) => {
            ggwave = obj;
            statusIndicator.className = 'status-dot online';
            statusText.innerText = 'ENGINE READY';
            sendBtn.disabled = false;
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
                currentProtocolId = protocolsMap[1]; // Default to Audible (Fast)
            }
            appendSystemMessage('SYSTEM DIAGNOSTICS', 'ggwave WebAssembly engine successfully initialized locally.');
        }).catch((err) => {
            console.error('Failed to load ggwave WASM factory:', err);
            statusText.innerText = 'ENGINE COMPILER ERROR';
            appendSystemMessage('CRITICAL ERROR', 'WebAssembly compiler failed to load ggwave binary. Make sure Javascipt/DOM storage is allowed.', true);
        });
    } else {
        statusText.innerText = 'LIBRARY LOAD FAILED';
        appendSystemMessage('CRITICAL ERROR', 'ggwave.js library not found or failed to load in WebView.', true);
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
function resizeCanvases() {
    const wrapper = spectrogramCanvas.parentElement;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    
    spectrogramCanvas.width = w;
    spectrogramCanvas.height = h;
    oscilloscopeCanvas.width = w;
    oscilloscopeCanvas.height = h;

    if (txWaveCanvas && messageInput) {
        txWaveCanvas.width = messageInput.parentElement.clientWidth || w;
        txWaveCanvas.height = 48;
    }

    // Fill with black backgrounds
    spectrogramCtx.fillStyle = '#06070a';
    spectrogramCtx.fillRect(0, 0, w, h);
    oscilloscopeCtx.fillStyle = '#06070a';
    oscilloscopeCtx.fillRect(0, 0, w, h);

    if (txWaveCtx && txWaveCanvas) {
        txWaveCtx.fillStyle = '#000';
        txWaveCtx.fillRect(0, 0, txWaveCanvas.width, txWaveCanvas.height);
    }
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
        sidebarOverlay.classList.add('visible');
    });
    const closeSidebar = () => {
        settingsSidebar.classList.remove('open');
        sidebarOverlay.classList.remove('visible');
    };
    closeSettingsBtn.addEventListener('click', closeSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);

    // Load secure settings on startup
    loadSecureSettings();
    bindSecureSettingsListeners();

    // Settings Inputs Binding
    protocolSelect.addEventListener('change', (e) => {
        const val = parseInt(e.target.value);
        // Map Inaudible (6, 7, 8) to base Ultrasound protocols (3, 4, 5)
        const mappedVal = (val >= 6 && val <= 8) ? (val - 3) : val;
        
        if (protocolsMap && protocolsMap[mappedVal] !== undefined) {
            currentProtocolId = protocolsMap[mappedVal];
        }
        const name = protocolSelect.options[protocolSelect.selectedIndex].text;
        activeProtocolLbl.innerText = name.split(' ')[0].toUpperCase() + '_' + name.split(' ')[1].replace(/[()]/g, '').toUpperCase();
        
        // Re-initialize engine context parameters if active
        if (ggwaveInstance && audioContext) {
            ggwaveParameters.sampleRateInp = audioContext.sampleRate;
            ggwaveParameters.sampleRateOut = audioContext.sampleRate;
            ggwaveInstance = ggwave.init(ggwaveParameters);
            ggwaveInstanceShifted = ggwave.init(ggwaveParameters);
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

    const chipsToggle = document.getElementById('chips-toggle');
    const chipsContainer = document.querySelector('.chips-container');
    if (chipsToggle && chipsContainer) {
        chipsToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                chipsContainer.classList.remove('hidden');
            } else {
                chipsContainer.classList.add('hidden');
            }
        });
    }

    loopbackTestBtn.addEventListener('click', runDiagnosticsLoopback);

    clearChatBtn.addEventListener('click', () => {
        chatMessages.innerHTML = '';
        appendSystemMessage('SYSTEM INFO', 'Chat feed cleared.');
        closeSidebar();
    });

    // Visualizer tabs switching
    document.getElementById('tab-spectrogram').addEventListener('click', (e) => {
        activeVizTab = 'spectrogram';
        e.target.classList.add('active');
        document.getElementById('tab-oscilloscope').classList.remove('active');
        spectrogramCanvas.classList.remove('hidden');
        oscilloscopeCanvas.classList.add('hidden');
    });

    document.getElementById('tab-oscilloscope').addEventListener('click', (e) => {
        activeVizTab = 'oscilloscope';
        e.target.classList.add('active');
        document.getElementById('tab-spectrogram').classList.remove('active');
        oscilloscopeCanvas.classList.remove('hidden');
        spectrogramCanvas.classList.add('hidden');
    });
}

// Set up visualizer drawing loop
function startVisualizer() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }
    
    const fftSize = 1024;
    analyserNode.fftSize = fftSize;
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const draw = () => {
        animationFrameId = requestAnimationFrame(draw);
        
        const w = spectrogramCanvas.width;
        const h = spectrogramCanvas.height;
        
        if (activeVizTab === 'spectrogram') {
            analyserNode.getByteFrequencyData(dataArray);
            
            // Shift spectrogram pixels down 1px
            spectrogramCtx.drawImage(spectrogramCanvas, 0, 0, w, h - 1, 0, 1, w, h - 1);
            
            // Render new frequency data line at the top (y=0)
            const sliceWidth = w / (bufferLength * 0.7); // Crop higher humanly inaudible ranges for layout density
            let x = 0;
            
            for (let i = 0; i < bufferLength; i++) {
                const value = dataArray[i];
                
                // Color mapper: Neon cyan/violet transition
                // Low frequency/amplitude -> Dark bluish
                // High frequency/amplitude -> Radiant Magenta/Cyan
                const r = Math.max(0, Math.min(255, value * 1.2 - 20));
                const g = Math.max(0, Math.min(255, value * 0.5));
                const b = Math.max(0, Math.min(255, value * 1.5 + 30));
                
                spectrogramCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                spectrogramCtx.fillRect(x, 0, Math.ceil(sliceWidth), 1);
                
                x += sliceWidth;
                if (x >= w) break;
            }
        } else {
            analyserNode.getByteTimeDomainData(dataArray);
            
            oscilloscopeCtx.fillStyle = '#06070a';
            oscilloscopeCtx.fillRect(0, 0, w, h);
            
            oscilloscopeCtx.lineWidth = 2;
            oscilloscopeCtx.strokeStyle = '#a8a8af';
            oscilloscopeCtx.shadowBlur = 4;
            oscilloscopeCtx.shadowColor = '#a8a8af';
            
            oscilloscopeCtx.beginPath();
            const sliceWidth = w / bufferLength;
            let x = 0;
            
            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0;
                const y = (v * h) / 2;
                
                if (i === 0) {
                    oscilloscopeCtx.moveTo(x, y);
                } else {
                    oscilloscopeCtx.lineTo(x, y);
                }
                
                x += sliceWidth;
            }
            
            oscilloscopeCtx.lineTo(w, h / 2);
            oscilloscopeCtx.stroke();
            oscilloscopeCtx.shadowBlur = 0; // reset shadow
        }
    };
    
    draw();
}

// Initialize audio session elements
function initAudio() {
    if (!audioContext) {
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        // Default system sample rate, ideally 48000 Hz for ggwave DSP accuracy
        audioContext = new AudioContext({ sampleRate: 48000 });
        
        // Setup ggwave parameters
        ggwaveParameters = ggwave.getDefaultParameters();
        ggwaveParameters.sampleRateInp = audioContext.sampleRate;
        ggwaveParameters.sampleRateOut = audioContext.sampleRate;
        
        // Initialize ggwave DSP tracker instances
        ggwaveInstance = ggwave.init(ggwaveParameters);
        ggwaveInstanceShifted = ggwave.init(ggwaveParameters);
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

// Start microphone pipeline
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
        microphoneStream = stream;
        mediaStreamNode = audioContext.createMediaStreamSource(stream);
        
        // Setup WebAudio analyzer
        analyserNode = audioContext.createAnalyser();
        mediaStreamNode.connect(analyserNode);
        
        // Setup javascript script processor for audio buffer slicing
        const bufferSize = 1024;
        const numberOfInputChannels = 1;
        const numberOfOutputChannels = 1;
        
        if (audioContext.createScriptProcessor) {
            recorderNode = audioContext.createScriptProcessor(
                bufferSize,
                numberOfInputChannels,
                numberOfOutputChannels
            );
        } else {
            recorderNode = audioContext.createJavaScriptNode(
                bufferSize,
                numberOfInputChannels,
                numberOfOutputChannels
            );
        }
        
        // Helper to parse and format received packets
        const handleDecodedBytes = async (bytes) => {
            try {
                const rawText = new TextDecoder('utf-8').decode(bytes);
                console.log('Successfully decoded raw sonic payload:', rawText);
                const parsed = await parseReceivedPacket(rawText);
                appendMessage(parsed.sender, parsed.message, 'received', parsed.encrypted);
                playReceivedChime();
                return true;
            } catch (decodeErr) {
                console.error('Decoding text payload failed:', decodeErr);
                return false;
            }
        };

        // Script processing tick (decoding mic data)
        let isProcessingAudio = false;
        recorderNode.onaudioprocess = async (e) => {
            if (isTransmitting || isProcessingAudio) return;

            const inputBuffer = e.inputBuffer;
            const channelData = inputBuffer.getChannelData(0);
            const channelDataCopy = new Float32Array(channelData);
            
            isProcessingAudio = true;
            try {
                if (rxGain !== 1.0) {
                    for (let i = 0; i < channelDataCopy.length; i++) {
                        channelDataCopy[i] *= rxGain;
                    }
                }
                
                // 1. Try decoding standard range
                const samplesInt8 = convertTypedArray(channelDataCopy, Int8Array);
                const decodedBytes = ggwave.decode(ggwaveInstance, samplesInt8);
                
                if (decodedBytes && decodedBytes.length > 0) {
                    await handleDecodedBytes(decodedBytes);
                } else {
                    // 2. Try decoding shifted (inaudible) range
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

        // Bind routing paths
        mediaStreamNode.connect(recorderNode);
        recorderNode.connect(audioContext.destination);

        isCapturing = true;
        captureToggleBtn.innerText = 'Stop Capture';
        captureToggleBtn.classList.add('active');
        rxStateIcon.innerText = '🟢';
        rxStateText.innerText = 'Listening for incoming audio data...';
        
        // Launch visualizer thread
        startVisualizer();
    }).catch((err) => {
        console.error('Microphone capture stream failed:', err);
        rxStateIcon.innerText = '❌';
        rxStateText.innerText = 'Permission denied. Mic is unavailable.';
        appendSystemMessage('PERMISSIONS ERROR', 'Microphone access is required to listen for incoming signals. Grant access inside Android prompts.', true);
    });
}

// Stop microphone capture
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
    captureToggleBtn.innerText = 'Start Capture';
    captureToggleBtn.classList.remove('active');
    rxStateIcon.innerText = '🎤';
    rxStateText.innerText = 'Audio capture paused. Press start to listen...';
    
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
            const val = parseInt(protocolSelect.value);
            const isInaudible = (val >= 6 && val <= 8);
            const activeProto = currentProtocolId || (protocolsMap ? protocolsMap[1] : null);
            
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
                const playSampleRate = isInaudible ? Math.round(audioContext.sampleRate * 1.0867) : audioContext.sampleRate;
                
                // Create buffer source
                const playBuffer = audioContext.createBuffer(1, floatArray.length, playSampleRate);
                playBuffer.getChannelData(0).set(floatArray);
                
                const bufferSource = audioContext.createBufferSource();
                bufferSource.buffer = playBuffer;
                bufferSource.connect(audioContext.destination);
                
                // On complete callback
                bufferSource.onended = () => {
                    isTransmitting = false;
                    sendBtn.disabled = false;
                    console.log('Transmission audio output finished.');
                    
                    // Restore microphone listening state
                    if (wasListening) {
                        rxStateText.innerText = 'Listening for incoming audio data...';
                    }
                };
                
                // Display message in chat feed
                const isEncrypted = !!myPasskey;
                appendMessage(myCallsign, text, 'sent', isEncrypted);
                
                // Show transmit visualizer wrapper and draw real-time scrolling wave
                if (txWaveWrapper && txWaveCanvas && txWaveCtx) {
                    txWaveWrapper.classList.remove('hidden');
                    txWaveCanvas.width = messageInput.parentElement.clientWidth;
                    const txStartTime = audioContext.currentTime;
                    
                    const drawTxWave = () => {
                        if (!isTransmitting) {
                            txWaveWrapper.classList.add('hidden');
                            return;
                        }
                        requestAnimationFrame(drawTxWave);
                        
                        const w = txWaveCanvas.width;
                        const h = txWaveCanvas.height;
                        txWaveCtx.fillStyle = '#000';
                        txWaveCtx.fillRect(0, 0, w, h);
                        
                        const elapsed = audioContext.currentTime - txStartTime;
                        const samplePos = Math.floor(elapsed * audioContext.sampleRate);
                        
                        const windowSize = 800; // Display window of 800 audio samples
                        const startIdx = Math.max(0, samplePos - windowSize / 2);
                        
                        txWaveCtx.lineWidth = 2.5;
                        txWaveCtx.strokeStyle = '#5a4d6c';
                        txWaveCtx.shadowBlur = 6;
                        txWaveCtx.shadowColor = '#5a4d6c';
                        txWaveCtx.beginPath();
                        
                        const sliceWidth = w / windowSize;
                        let x = 0;
                        
                        for (let i = 0; i < windowSize; i++) {
                            const idx = startIdx + i;
                            const val = idx < floatArray.length ? floatArray[idx] : 0;
                            const y = (h / 2) + (val * (h / 2.2));
                            
                            if (i === 0) {
                                txWaveCtx.moveTo(x, y);
                            } else {
                                txWaveCtx.lineTo(x, y);
                            }
                            x += sliceWidth;
                        }
                        txWaveCtx.stroke();
                        txWaveCtx.shadowBlur = 0;
                    };
                    drawTxWave();
                }
                
                // Play wave buffer
                bufferSource.start(0);
            } else {
                throw new Error('ggwave.encode returned an empty buffer.');
            }
        } catch (encodeErr) {
            console.error('Error during message transmission modulation:', encodeErr);
            appendSystemMessage('TRANSMIT ERROR', 'Data modulation failed. Try reducing message length.', true);
            isTransmitting = false;
            sendBtn.disabled = false;
        }
    });
}

// Append message into scrollable chat view
function appendMessage(sender, text, direction, isEncrypted = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${direction}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    
    // Callsign name header
    if (sender) {
        const senderLabel = document.createElement('div');
        senderLabel.className = 'msg-sender';
        senderLabel.innerText = sender;
        contentDiv.appendChild(senderLabel);
    }
    
    const textSpan = document.createElement('span');
    textSpan.innerText = text;
    contentDiv.appendChild(textSpan);
    
    // Encryption Lock indicator
    if (isEncrypted) {
        const lockIcon = document.createElement('span');
        lockIcon.style.fontSize = '10px';
        lockIcon.style.opacity = '0.7';
        lockIcon.style.marginLeft = '6px';
        lockIcon.innerText = '🔒';
        contentDiv.appendChild(lockIcon);
    }
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    const now = new Date();
    timeSpan.innerText = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timeSpan);
    
    chatMessages.appendChild(messageDiv);
    
    // Auto-scroll chat to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Append specialized diagnostics/system notifications
function appendSystemMessage(title, text, isError = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message system';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    if (isError) {
        contentDiv.style.borderColor = 'rgba(255, 0, 85, 0.3)';
    }
    
    const titleStr = isError ? `❌ ${title}` : `⚙️ ${title}`;
    const color = isError ? 'var(--accent-danger)' : 'var(--accent-secondary)';
    
    contentDiv.innerHTML = `<strong style="color: ${color}">${titleStr}</strong><p>${text}</p>`;
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.innerText = 'SYSTEM';
    
    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timeSpan);
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Template chips quick trigger
function useTemplate(text) {
    messageInput.value = text;
    messageInput.focus();
    // Enable send button
    sendBtn.disabled = false;
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
            const activeProto = currentProtocolId || (protocolsMap ? protocolsMap[1] : null);
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
                    appendSystemMessage('DIAGNOSTICS PASSED', 'Local loopback transmission validated. WebAssembly and AudioContext are 100% operational.');
                } else {
                    throw new Error(`Decoded payload mismatch. Got: "${text}"`);
                }
            } else {
                throw new Error('Demodulator failed to detect sync boundaries.');
            }
        } catch (err) {
            console.error('Diagnostics self-test failed:', err);
            testResult.innerText += `\n[FAILED] ${err.message}`;
            testResult.style.color = 'var(--accent-danger)';
            appendSystemMessage('DIAGNOSTICS FAILED', `Self-test failed: ${err.message}`, true);
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
