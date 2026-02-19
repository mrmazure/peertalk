// App Entry Point
const audio = new AudioEngine();
const ui = new UIManager(audio);
let peer = null;
let myStream = null;
let connections = []; // Keep track of data connections (Chat + Signaling)
let calls = {};       // Keep track of media calls
let myName = "Hôte"; // Store user's chosen name
let myDeviceName = "Défaut"; // Store device label

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

    // 2. Initialize PeerJS
    peer = new Peer({ debug: 2 });

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
        // Answer automatically with our stream - STRICT MONO (No SDP Transform)
        call.answer(myStream);
        handleStream(call);
    });

    peer.on('connection', (conn) => {
        console.log('Data connection from', conn.peer);
        setupDataConnection(conn);
    });

    peer.on('error', (err) => {
        console.error('Peer error:', err);
        if (err.type !== 'peer-unavailable') {
            ui.addChatMessage(`Erreur: ${err.type}`, 'Système', true);
        }
    });

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

function connectToPeer(peerId) {
    if (calls[peerId] || peerId === peer.id) return;

    ui.addChatMessage(`Connexion à ${peerId}...`, 'Système', true);

    // 1. Data Connection (Chat + Mesh signaling)
    const conn = peer.connect(peerId);
    setupDataConnection(conn);

    // 2. Media Call - STRICT MONO
    console.log(`Calling peer ${peerId} with stream`, myStream);
    const call = peer.call(peerId, myStream);
    handleStream(call);
}

function handleStream(call) {
    calls[call.peer] = call;

    call.on('stream', (remoteStream) => {
        console.log('Received stream from', call.peer, remoteStream);
        audio.setupRemoteAudio(call.peer, remoteStream);
        ui.createRemoteCard(call.peer);
    });

    call.on('close', () => {
        console.log('Call closed', call.peer);
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

        // MESH: Send our connected peers to the new peer
        const connectedPeers = connections
            .map(c => c.peer)
            .filter(id => id !== conn.peer && id !== peer.id);

        if (connectedPeers.length > 0) {
            conn.send({ type: 'peers', peers: connectedPeers });
        }

        // Broadcast metadata immediately - STRICTLY NO STEREO FLAG
        conn.send({ type: 'metadata', name: myName, device: myDeviceName });

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

    // 3. Remove UI
    ui.removeCard(peerId);
}

function broadcastMetadata() {
    connections.forEach(conn => {
        if (conn.open) {
            conn.send({ type: 'metadata', name: myName, device: myDeviceName });
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
