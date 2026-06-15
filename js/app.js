// App Entry Point
const audio = new AudioEngine();
const ui = new UIManager(audio);
let peer = null;
let myStream = null;
let connections = []; // Keep track of data connections (Chat + Signaling)
let calls = {};       // Keep track of media calls
let myName = "Hôte"; // Store user's chosen name
let myDeviceName = "Défaut"; // Store device label
let myMuted = false; // Local mute state, shared with peers
let qualityInterval = null; // Single global interval polling connection quality

async function init(startName) {
    if (startName) myName = startName;

    // 1. Initialize Audio
    // Propagate errors to caller
    await audio.initCHECK();
    // Default Mono
    myStream = await audio.getLocalStream();

    // Get device label from stream track
    const track = myStream.getAudioTracks()[0];
    if (track) {
        myDeviceName = track.label || "Microphone Inconnu";
    }

    audio.setupLocalAnalyser();

    // Determine role based on URL hash (No hash = Host, Hash = Guest joining)
    const isGuest = window.location.hash.length > 1; // # + id
    const localLabel = isGuest ? 'Vous' : 'Vous (Hôte)';

    // SHOW UI IMMEDIATELY (Don't wait for PeerJS)
    ui.createLocalCard('local', localLabel);

    // 2. Initialize PeerJS with a short, human-friendly room id
    setupPeer(generateRoomId());

    // 2b. Start polling per-peer connection quality
    startQualityMonitor();

    // 3. UI Events
    const shareBtn = document.getElementById('share-btn');
    const sharePopup = document.getElementById('share-popup');
    const closeBtn = document.querySelector('.close-modal');
    const copyBtn = document.getElementById('copy-link-btn');
    const linkInput = document.getElementById('share-link-input');
    const qrImage = document.getElementById('qr-code');

    shareBtn.style.display = 'inline-block'; // Show button when ready

    shareBtn.addEventListener('click', () => {
        const url = `${window.location.origin}${window.location.pathname}#${peer.id}`;
        linkInput.value = url;
        // Generate QR Code via API
        qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(url)}`;
        sharePopup.style.display = 'block';
    });

    closeBtn.addEventListener('click', () => {
        sharePopup.style.display = 'none';
    });

    window.addEventListener('click', (event) => {
        if (event.target == sharePopup) {
            sharePopup.style.display = 'none';
        }
    });

    copyBtn.addEventListener('click', () => {
        linkInput.select();
        document.execCommand('copy');
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copié !';
        setTimeout(() => copyBtn.textContent = originalText, 2000);
    });

    document.getElementById('send-btn').addEventListener('click', sendMessage);
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    // Mobile Chat Toggle
    const chatBtn = document.getElementById('toggle-chat-btn');
    const chatSidebar = document.getElementById('chat-sidebar');

    if (chatBtn) {
        chatBtn.addEventListener('click', () => {
            chatSidebar.classList.toggle('open');
            // Toggle visual state
            if (chatSidebar.classList.contains('open')) {
                chatBtn.classList.remove('btn-secondary');
                chatBtn.classList.add('btn-primary');
            } else {
                chatBtn.classList.add('btn-secondary');
                chatBtn.classList.remove('btn-primary');
            }
        });
    }

    // Close chat when clicking outside on mobile
    document.addEventListener('click', (e) => {
        if (window.innerWidth <= 768 &&
            chatSidebar.classList.contains('open') &&
            !chatSidebar.contains(e.target) &&
            !chatBtn.contains(e.target)) {

            chatSidebar.classList.remove('open');
            chatBtn.classList.add('btn-secondary');
            chatBtn.classList.remove('btn-primary');
        }
    });

    // Eject event - Modified to send KICK command
    document.addEventListener('eject-peer', (e) => {
        const peerId = e.detail.peerId;
        const conn = connections.find(c => c.peer === peerId);

        if (conn && conn.open) {
            conn.send({ type: 'kick' });
            ui.addChatMessage(`A éjecté ${peerId}`, 'Système', true);
            // Give them a moment to receive it and leave, then force close locally
            setTimeout(() => {
                cleanupPeer(peerId);
            }, 500);
        } else {
            // Already closed or not found
            cleanupPeer(peerId);
        }
    });

    // Name change event (Local & Remote)
    document.addEventListener('my-name-changed', (e) => {
        myName = e.detail.name;
        broadcastMetadata();
    });

    // Local mute toggle -> share state with all peers
    document.addEventListener('local-mute-changed', (e) => {
        myMuted = e.detail.muted;
        connections.forEach(conn => {
            if (conn.open) conn.send({ type: 'mute', muted: myMuted });
        });
    });

    // Stream changed event (e.g. mic change)
    document.addEventListener('local-stream-changed', (e) => {
        const newStream = e.detail.stream;
        myStream = newStream;

        const track = myStream.getAudioTracks()[0];
        if (track) myDeviceName = track.label;
        broadcastMetadata();

        Object.values(calls).forEach(call => {
            if (call.peerConnection) {
                const senders = call.peerConnection.getSenders();
                const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
                if (audioSender) {
                    audioSender.replaceTrack(newStream.getAudioTracks()[0]);
                }
            }
        });
    });
}

// Generate a short room id: 5 chars from A-Z and 0-9
function generateRoomId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 5; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

// Improve Opus quality on the fmtp line WITHOUT adding latency.
// Forces 128 kbps, disables DTX, full 48 kHz playback, strict mono.
// We deliberately do NOT enable FEC nor raise ptime (both add latency).
function tuneOpusSdp(sdp) {
    if (!sdp) return sdp;

    const lines = sdp.split('\r\n');
    const rtpmapRe = /^a=rtpmap:(\d+)\s+opus\/48000/i;

    // Find the Opus payload type
    let opusPt = null;
    for (const line of lines) {
        const m = line.match(rtpmapRe);
        if (m) { opusPt = m[1]; break; }
    }
    if (!opusPt) return sdp;

    const desired = {
        'maxaveragebitrate': '128000',
        'usedtx': '0',
        'maxplaybackrate': '48000',
        'stereo': '0',
        'sprop-stereo': '0'
    };

    const fmtpPrefix = `a=fmtp:${opusPt} `;
    let found = false;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(fmtpPrefix)) {
            found = true;
            // Merge existing params with the desired ones (desired wins)
            const map = {};
            lines[i].substring(fmtpPrefix.length).split(';')
                .map(s => s.trim()).filter(Boolean)
                .forEach(p => {
                    const idx = p.indexOf('=');
                    if (idx > -1) map[p.substring(0, idx).trim()] = p.substring(idx + 1).trim();
                    else map[p] = null;
                });
            Object.assign(map, desired);
            const merged = Object.entries(map)
                .map(([k, v]) => (v === null ? k : `${k}=${v}`)).join(';');
            lines[i] = fmtpPrefix + merged;
            break;
        }
    }

    // No fmtp line for opus yet: add one right after its rtpmap line
    if (!found) {
        for (let i = 0; i < lines.length; i++) {
            if (rtpmapRe.test(lines[i])) {
                const params = Object.entries(desired).map(([k, v]) => `${k}=${v}`).join(';');
                lines.splice(i + 1, 0, fmtpPrefix + params);
                break;
            }
        }
    }

    return lines.join('\r\n');
}

// Create the Peer and wire up all its handlers (callable again on id collision)
function setupPeer(id) {
    peer = new Peer(id, { debug: 2 });

    peer.on('open', (id) => {
        console.log('My Peer ID:', id);

        const statusEl = document.getElementById('connection-status');
        statusEl.textContent = 'En ligne';
        statusEl.style.color = 'var(--success)';

        // Check for URL hash to connect
        const hash = window.location.hash.substring(1);
        if (hash && hash !== id) {
            connectToPeer(hash);
        } else {
            // Update the invite card now that we have the hash (if we are host) and the ID is ready
            ui.updateInviteCard(id);
        }
    });

    peer.on('call', (call) => {
        console.log('Incoming call from', call.peer);
        // Answer with our MONO stream + tuned Opus SDP (quality only, no added latency)
        call.answer(myStream, { sdpTransform: tuneOpusSdp });
        handleStream(call);
    });

    peer.on('connection', (conn) => {
        console.log('Data connection from', conn.peer);
        setupDataConnection(conn);
    });

    // Signaling server reconnection
    peer.on('disconnected', () => {
        ui.addChatMessage('Reconnexion au serveur...', 'Système', true);
        if (!peer.destroyed) peer.reconnect();
    });

    peer.on('error', (err) => {
        console.error('Peer error:', err);
        // Short id collision: pick a new one and recreate the Peer
        if (err.type === 'unavailable-id') {
            try { peer.destroy(); } catch (e) { /* ignore */ }
            setupPeer(generateRoomId());
            return;
        }
        if (err.type !== 'peer-unavailable') {
            ui.addChatMessage(`Erreur: ${err.type}`, 'Système', true);
        }
    });
}

// Initiate a media call ONLY if we are the deterministic initiator (higher id).
// Avoids "glare": when two peers discover each other simultaneously, exactly one calls.
function ensureMediaCall(peerId) {
    if (!peerId || peerId === peer.id) return;
    if (calls[peerId]) return; // already have a media stream for this peer

    if (peer.id > peerId) {
        console.log(`Calling peer ${peerId} with stream (initiator)`, myStream);
        const call = peer.call(peerId, myStream, { sdpTransform: tuneOpusSdp });
        handleStream(call);
    } else {
        console.log(`Waiting for incoming call from ${peerId} (non-initiator)`);
    }
}

function connectToPeer(peerId) {
    if (peerId === peer.id) return;

    // 1. Data Connection (Chat + Mesh signaling) - stays bidirectional.
    //    Only open a new one if we don't already have a data connection to this peer.
    if (!connections.some(c => c.peer === peerId)) {
        ui.addChatMessage(`Connexion à ${peerId}...`, 'Système', true);
        const conn = peer.connect(peerId);
        setupDataConnection(conn);
    }

    // 2. Media Call - only the deterministic initiator calls (glare avoidance)
    ensureMediaCall(peerId);
}

// Poll the live connection quality of every active media call (single global interval)
function startQualityMonitor() {
    if (qualityInterval) clearInterval(qualityInterval);

    qualityInterval = setInterval(() => {
        Object.keys(calls).forEach(async (peerId) => {
            const call = calls[peerId];
            if (call && call.peerConnection) {
                const result = await audio.getConnectionQuality(call.peerConnection, peerId);
                ui.updateConnectionQuality(peerId, result);
            }
        });
    }, 2500);
}

// Watch the ICE state of a call's RTCPeerConnection and auto-reconnect on failure.
function attachIceMonitor(call) {
    const pc = call.peerConnection;
    if (!pc || call._iceMonitored) return;
    call._iceMonitored = true;

    let reconnectTimer = null;

    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log(`ICE state (${call.peer}):`, state);

        if (state === 'failed') {
            // Terminal -> reconnect immediately
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            attemptMediaReconnect(call.peer);
        } else if (state === 'disconnected') {
            // May be transient -> wait, then reconnect only if still down
            if (!reconnectTimer) {
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    const s = pc.iceConnectionState;
                    if (s === 'disconnected' || s === 'failed') {
                        attemptMediaReconnect(call.peer);
                    }
                }, 4000);
            }
        } else if (state === 'connected' || state === 'completed') {
            // Recovered on its own -> cancel any pending reconnect
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        }
    };
}

// Re-establish a dropped media call without reloading the page.
function attemptMediaReconnect(peerId) {
    // 1. Only reconnect if the data-connection is still open; otherwise it's a real departure.
    const conn = connections.find(c => c.peer === peerId && c.open);
    if (!conn) {
        cleanupPeer(peerId);
        return;
    }

    // Tear down the stale media call WITHOUT removing the card (flag avoids UI flicker)
    const oldCall = calls[peerId];
    if (oldCall) {
        oldCall._reconnecting = true;
        try { oldCall.close(); } catch (e) { /* ignore */ }
        delete calls[peerId];
    }
    audio.cleanupPeer(peerId); // release the dead stream's audio element + analysers

    // 2. Anti-glare: only the higher id re-initiates; the other waits for the incoming call.
    if (peer.id > peerId) {
        ui.addChatMessage(`Reconnexion audio à ${peerId}...`, 'Système', true);
        ensureMediaCall(peerId);
    }
}

function handleStream(call) {
    calls[call.peer] = call;
    attachIceMonitor(call); // monitor ICE as soon as the peer connection is available

    call.on('stream', (remoteStream) => {
        console.log('Received stream from', call.peer, remoteStream);
        audio.setupRemoteAudio(call.peer, remoteStream);
        ui.createRemoteCard(call.peer);
        ui.updateConnectionStatus(call.peer, 'connected');
        attachIceMonitor(call); // ensure it's wired once the pc exists
    });

    call.on('close', () => {
        console.log('Call closed', call.peer);
        // During an auto-reconnect we deliberately keep the card and the new call
        if (call._reconnecting) return;
        audio.cleanupPeer(call.peer); // release audio element + analysers
        ui.removeCard(call.peer);
        delete calls[call.peer];
    });

    call.on('error', (err) => {
        console.error('Call error', err);
        ui.addChatMessage(`Erreur d'appel: ${err}`, 'Système', true);
    });
}

function setupDataConnection(conn) {
    console.log('Setting up data connection for', conn.peer);
    connections.push(conn);

    conn.on('open', () => {
        console.log('Data channel open with', conn.peer);

        // Update Status Dot to Green
        ui.updateConnectionStatus(conn.peer, 'connected');

        // Glare avoidance: now that we know this peer, the higher id initiates the call.
        ensureMediaCall(conn.peer);

        // MESH: Send our connected peers to the new peer
        const connectedPeers = connections
            .map(c => c.peer)
            .filter(id => id !== conn.peer && id !== peer.id);

        if (connectedPeers.length > 0) {
            conn.send({ type: 'peers', peers: connectedPeers });
        }

        // Broadcast metadata immediately - STRICTLY NO STEREO FLAG (include current mute state)
        conn.send({ type: 'metadata', name: myName, device: myDeviceName, muted: myMuted });

        conn.send({ type: 'chat', text: 'A rejoint le salon', author: myName });
    });

    conn.on('data', (data) => {
        if (data.type === 'chat') {
            ui.addChatMessage(data.text, data.author);
        }
        if (data.type === 'peers') {
            console.log('Received peer list:', data.peers);
            data.peers.forEach(id => {
                if (id !== peer.id && !calls[id]) {
                    connectToPeer(id);
                }
            });
        }
        if (data.type === 'metadata') {
            if (data.name) ui.updatePeerName(conn.peer, data.name);
            if (data.device) ui.updatePeerDevice(conn.peer, data.device);
            if (typeof data.muted === 'boolean') ui.setPeerMuted(conn.peer, data.muted);
        }
        // Peer toggled their microphone
        if (data.type === 'mute') {
            ui.setPeerMuted(conn.peer, !!data.muted);
        }
        // Handle explicit disconnect signal
        if (data.type === 'bye') {
            console.log('Received BYE from', conn.peer);
            ui.addChatMessage(`${conn.peer} est parti (Bye)`, 'Système', true);
            cleanupPeer(conn.peer);
        }
        // Handle KICK signal
        if (data.type === 'kick') {
            // 1. Broadcast bye to everyone else (except the host who kicked us, typically)
            connections.forEach(c => { if (c.open) c.send({ type: 'bye' }); });

            // 2. Destroy Peer immediately to cut all links
            if (peer) peer.destroy();

            // 3. Show message (Non-blocking)
            document.body.innerHTML = `
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#101014; color:white; font-family:sans-serif;">
                    <h1 style="color:#ef4444;">Vous avez été éjecté</h1>
                    <p>L'hôte a mis fin à votre connexion.</p>
                    <button onclick="window.location.reload()" style="padding:10px 20px; margin-top:20px; cursor:pointer;">Retour à l'accueil</button>
                </div>
            `;
        }
    });

    conn.on('close', () => {
        console.log('Connection closed for', conn.peer);
        cleanupPeer(conn.peer);
    });

    conn.on('error', (err) => {
        console.log('Connection error for', conn.peer, err);
        cleanupPeer(conn.peer);
    });
}

// Helper to reliably remove a peer
function cleanupPeer(peerId) {
    if (!peerId) return;

    console.log('Cleaning up peer:', peerId);

    // 1. Close and remove Data Connection
    const connIndex = connections.findIndex(c => c.peer === peerId);
    if (connIndex !== -1) {
        // We generally don't call .close() here if it was triggered by .on('close')
        // to avoid recursion, but it's safe if we remove it from array first.
        const conn = connections[connIndex];
        connections.splice(connIndex, 1);
        // conn.close(); // Optional, usually already closed
    }

    // 2. Close and remove Call
    if (calls[peerId]) {
        calls[peerId].close();
        delete calls[peerId];
    }

    // 3. Release audio resources (audio element + analysers) to avoid leaks
    audio.cleanupPeer(peerId);

    // 4. Remove UI
    ui.removeCard(peerId);
}

function broadcastMetadata() {
    connections.forEach(conn => {
        if (conn.open) {
            conn.send({ type: 'metadata', name: myName, device: myDeviceName, muted: myMuted });
        }
    });
}

function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    ui.addChatMessage(text, 'Moi');

    connections.forEach(conn => {
        if (conn.open) {
            conn.send({ type: 'chat', text: text, author: myName });
        }
    });

    input.value = '';
}

// Start
// init(); <-- Removed auto-start

// ... (init function remains same)

// Pre-fill name from localStorage or generate random
document.addEventListener('DOMContentLoaded', () => {
    const nameInput = document.getElementById('start-name');
    const savedName = localStorage.getItem('peerCallName');

    if (savedName) {
        nameInput.value = savedName;
    } else {
        // Suggest a random name
        const randomId = Math.floor(Math.random() * 10000);
        nameInput.value = `Invité ${randomId}`;
    }
});

document.getElementById('start-btn').addEventListener('click', async () => {
    const nameInput = document.getElementById('start-name');
    const startBtn = document.getElementById('start-btn');
    const overlay = document.getElementById('start-overlay');

    const name = nameInput.value.trim() || `Invité ${Math.floor(Math.random() * 10000)}`;

    // Save to localStorage
    localStorage.setItem('peerCallName', name);

    // Visual feedback
    startBtn.disabled = true;
    startBtn.textContent = "Initialisation...";

    try {
        await init(name);
        // Only hide if successful
        overlay.style.display = 'none';
    } catch (e) {
        console.error("Init failed:", e);
        // Reset button
        startBtn.disabled = false;
        startBtn.textContent = "Démarrer la Conférence";
        // Alert user with specific error details
        alert(`Erreur d'initialisation audio: ${e.name} - ${e.message}\n\nVérifiez que le microphone n'est pas utilisé par une autre application.`);
    }
});
