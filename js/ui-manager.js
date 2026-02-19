class UIManager {
    constructor(audioEngine) {
        this.audio = audioEngine;
        this.grid = document.getElementById('grid-container');
        this.chatMessages = document.getElementById('chat-messages');
    }

    createLocalCard(peerId, label) {
        // Check if we are the room host (no hash)
        const isRoomHost = !window.location.hash || window.location.hash === '#';

        const card = this.createCardElement('local', label, true, isRoomHost);
        this.grid.appendChild(card);
        this.setupDeviceSelectors('local');
        this.startVULoop('local');
        this.checkEmptyState();
    }

    createRemoteCard(peerId, label) {
        this.checkEmptyState(); // Remove invite card if it exists

        // Avoid duplicate cards
        if (document.getElementById(`card-${peerId}`)) return;

        // Check if this peer is the Host (matches the URL hash that we joined)
        const roomHostId = window.location.hash.substring(1);
        const isRoomHost = roomHostId && peerId === roomHostId;

        // Append (Hôte) if it is the host
        let displayLabel = label || `Guest ${peerId.substr(0, 4)}`;
        // We will handle the visual "Hôte" badge in the HTML construction if we want, 
        // asking "display who the original host is".
        // Let's pass a specific flag or just append to name for now, but `updatePeerName` might overwrite it.
        // Better to add a permanent badge in `createCardElement`?
        // `createCardElement` is generic.
        // Let's just append to the visual name for now, and handle it in `updatePeerName` too.

        const card = this.createCardElement(peerId, displayLabel, false, isRoomHost);
        this.grid.appendChild(card);
        this.setupDeviceSelectors(peerId);
        this.startVULoop(peerId);

        // Setup Eject Button
        const ejectBtn = card.querySelector('.btn-eject');
        if (ejectBtn) {
            ejectBtn.addEventListener('click', () => {
                const event = new CustomEvent('eject-peer', { detail: { peerId } });
                document.dispatchEvent(event);
            });
        }

        this.checkEmptyState();
    }

    removeCard(peerId) {
        const card = document.getElementById(`card-${peerId}`);
        if (card) card.remove();
        // also remove audio element
        const audio = document.getElementById(`audio-${peerId}`);
        if (audio) audio.remove();

        this.checkEmptyState();
    }

    checkEmptyState(myPeerId = null) {
        const remoteCards = this.grid.querySelectorAll('.user-card.remote');
        const inviteCardId = 'invite-card-placeholder';
        let inviteCard = document.getElementById(inviteCardId);

        if (remoteCards.length === 0) {
            // Show Invite Card
            if (!inviteCard) {
                inviteCard = document.createElement('div');
                inviteCard.className = 'user-card invite-card';
                inviteCard.id = inviteCardId;
                inviteCard.style.justifyContent = 'center';
                inviteCard.style.alignItems = 'center';
                inviteCard.style.borderStyle = 'dashed';
                inviteCard.style.borderColor = 'var(--text-muted)';
                inviteCard.style.background = 'transparent';
                this.grid.appendChild(inviteCard);
            }

            // Content depends on whether we are ready (myPeerId exists)
            if (!myPeerId && !this.lastKnownPeerId) {
                // Loading State
                inviteCard.innerHTML = `
                    <div style="text-align:center; color: var(--text-muted);">
                        <div class="spinner" style="border: 4px solid rgba(255,255,255,0.1); border-left-color: var(--primary); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 15px;"></div>
                        <h3>Création du salon...</h3>
                        <p style="font-size:0.8rem;">Initialisation de la connexion...</p>
                    </div>
                    <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
                `;
            } else {
                // Ready State
                const idToShare = myPeerId || this.lastKnownPeerId;
                this.lastKnownPeerId = idToShare; // Cache it

                // Construct URL: Current Origin + Path + #ID
                const url = `${window.location.origin}${window.location.pathname}#${idToShare}`;
                const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(url)}`;

                inviteCard.innerHTML = `
                    <div style="text-align:center; color: var(--text-muted);">
                        <i class="fas fa-plus-circle" style="font-size: 2rem; margin-bottom: 10px;"></i>
                        <h3>Inviter un coanimateur</h3>
                        <img src="${qrUrl}" style="width:100px; height:100px; margin:10px 0; border-radius:4px;">
                        <p style="font-size:0.8rem; word-break:break-all; user-select: text;">${url}</p>
                        <button class="btn btn-primary" onclick="navigator.clipboard.writeText('${url}'); this.textContent='Copié!'; setTimeout(()=>this.textContent='Copier Lien', 2000);">Copier Lien</button>
                    </div>
                `;
            }

        } else {
            // Hide/Remove Invite Card
            if (inviteCard) inviteCard.remove();
        }
    }

    updateInviteCard(myPeerId) {
        // Force refresh of invite card if it exists or needs to exist
        const inviteCard = document.getElementById('invite-card-placeholder');
        if (inviteCard) {
            this.checkEmptyState(myPeerId);
        } else {
            this.checkEmptyState(myPeerId);
        }
    }

    startVULoop(id) {
        const canvas = document.getElementById(`vu-${id}`);
        if (!canvas) return;

        const ctx = canvas.getContext('2d');

        const draw = () => {
            // 1. Check if element still exists
            const card = document.getElementById(`card-${id}`);
            if (!card) return;

            // 2. Schedule next frame
            requestAnimationFrame(draw);

            // 3. Resize Logic (Safe)
            const parent = canvas.parentElement;
            if (parent) {
                const w = parent.clientWidth;
                const h = parent.clientHeight;
                if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
                    canvas.width = w;
                    canvas.height = h;
                }
            }

            // 4. Draw
            const width = canvas.width;
            const height = canvas.height;

            // Clear
            ctx.fillStyle = '#111';
            ctx.fillRect(0, 0, width, height);

            if (width === 0 || height === 0) return; // Nothing to draw

            // ALWAYS MONO drawing logic as requested to revert
            const valL = this.audio.getAudioLevel(id, 0) || 0;
            const valR = this.audio.getAudioLevel(id, 1) || 0;
            const value = Math.max(valL, valR);

            // Draw Horizontal Bar
            const barHeight = height * 0.6; // Slightly thinner bar
            const barWidth = width * (value / 255);
            const x = 0;
            const y = (height - barHeight) / 2; // Center vertically

            // Gradient Color (Horizontal)
            const gradient = ctx.createLinearGradient(0, 0, width, 0);
            gradient.addColorStop(0, '#22c55e'); // Green
            gradient.addColorStop(0.6, '#f59e0b'); // Yellow
            gradient.addColorStop(1, '#ef4444'); // Red

            ctx.fillStyle = gradient;
            ctx.fillRect(x, y, barWidth, barHeight);
        };

        // Start
        draw();
    }

    createCardElement(id, name, isLocal, isRoomHost = false) {
        const div = document.createElement('div');
        div.className = `user-card ${isLocal ? 'local' : 'remote'}`;
        div.id = `card-${id}`;

        // Determine if I am the Host (to decide if I can show the eject button)
        // I am host if no hash or hash is just '#'
        const amIHost = !window.location.hash || window.location.hash === '#';

        // Standardize Host Badge
        // Remove text-based "(Hôte)" if present in name to avoid double labeling if passed
        let displayName = name.replace(' (Hôte)', '').replace('(Hôte)', '');

        if (isRoomHost) {
            displayName += ' <span style="color:var(--primary); font-size:0.8em; font-weight:bold;">(Hôte)</span>';
        }

        const nameHtml = `<div class="user-name" id="name-${id}" style="font-size: 1.4rem; text-align: center; width: 100%; display: block;">${displayName}</div>`;

        // Status dot + Text
        // Default text based on isLocal
        const initialStatusText = isLocal ? 'Connecté (Vous)' : 'En attente...';
        const statusHtml = `
            <div class="status-container" style="display: flex; justify-content: center; align-items: center; gap: 8px; margin-top: 8px;">
                <span id="status-${id}" class="status-dot ${isLocal ? 'connected' : ''}"></span>
                <span id="status-text-${id}" style="font-size: 0.85rem; color: var(--text-muted);">${initialStatusText}</span>
            </div>
        `;

        div.innerHTML = `
            <div class="card-header" style="justify-content: center; width: 100%;">
                ${nameHtml}
            </div>
            
            <div class="vu-meter-container" style="margin-top: 5px;">
                <canvas id="vu-${id}" class="vu-canvas"></canvas>
            </div>

            <div class="card-actions" style="display: flex; justify-content: center; padding-top: 10px; width: 100%;">
                <button class="btn btn-secondary btn-mute" title="Couper/Activer le son">MUTE</button>
                ${!isLocal && amIHost ? `<div style="width: 10px;"></div><button class="btn btn-danger btn-eject" title="Éjecter">X</button>` : ''}
            </div>

            ${statusHtml}

            <div class="device-controls" style="margin-top: 10px;">
                ${isLocal ? `
                <div class="control-group">
                    <select id="input-${id}"></select>
                </div>
                ` : `
                <div class="control-group">
                    <div class="remote-device-label" id="device-${id}" style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px; text-align: center;">Micro Inconnu</div>
                    <label style="text-align: center;">Sortie Audio</label>
                    <select id="output-${id}"></select>
                </div>
                `}
            </div>
        `;

        // Setup Events
        const muteBtn = div.querySelector('.btn-mute');
        muteBtn.addEventListener('click', () => {
            // Visual toggle
            const isMuted = !muteBtn.classList.contains('btn-danger'); // If not red, we are muting

            if (isMuted) {
                muteBtn.classList.remove('btn-secondary');
                muteBtn.classList.add('btn-danger');
            } else {
                muteBtn.classList.add('btn-secondary');
                muteBtn.classList.remove('btn-danger');
            }

            // Text stays "MUTE" as requested, or we can use icon. User said "I prefer a MUTE".
            // muteBtn.textContent = 'MUTE'; 

            if (isLocal) {
                this.audio.muteLocal(isMuted);
            } else {
                this.audio.mutePeer(id, isMuted);
            }
        });

        // NO STEREO CHECKBOX EVENT
        // NOTE: Remote buttons (mute/eject) logic was previously outside this function in createRemoteCard.
        // We should consolidate it or ensure we don't duplicate events. 
        // `createRemoteCard` adds listeners too. Let's make sure we don't verify modify createRemoteCard to NOT add them if we add them here.
        // Actually, looking at `createRemoteCard` (Step 194), it DOES add listeners.
        // If I add one here, both run. Not ideal.

        // I will MODIFY `createRemoteCard` in `ui-manager` to remove the event listeners setup there, and rely on `createCardElement`.

        return div;
    }

    updateConnectionStatus(peerId, status) {
        const dot = document.getElementById(`status-${peerId}`);
        const textLabel = document.getElementById(`status-text-${peerId}`);

        if (dot) {
            dot.className = `status-dot ${status}`; // connected, disconnected, or empty (connecting)
            dot.title = status === 'connected' ? 'Connecté' : 'Déconnecté';
        }
        if (textLabel) {
            if (status === 'connected') textLabel.textContent = 'Connecté';
            else if (status === 'disconnected') textLabel.textContent = 'Déconnecté';
            else textLabel.textContent = 'En attente...';
        }
    }

    updatePeerName(peerId, name) {
        const el = document.getElementById(`name-${peerId}`);
        if (el) {
            // Check if this peer is the host
            const roomHostId = window.location.hash.substring(1);
            let displayName = name.replace(' (Hôte)', '').replace('(Hôte)', '');

            if (roomHostId && peerId === roomHostId) {
                displayName += ' <span style="color:var(--primary); font-size:0.8em; font-weight:bold;">(Hôte)</span>';
            }

            el.innerHTML = displayName;
        }
    }

    updatePeerDevice(peerId, deviceName) {
        const el = document.getElementById(`device-${peerId}`);
        if (el) {
            el.textContent = `Micro Distant: ${deviceName}`;
        }
    }

    async setupDeviceSelectors(id) {
        const devices = await this.audio.getDevices();
        const inputSelect = document.getElementById(`input-${id}`);
        const outputSelect = document.getElementById(`output-${id}`);

        if (inputSelect) {
            const inputs = devices.filter(d => d.kind === 'audioinput');

            // Clear existing
            inputSelect.innerHTML = '';

            inputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.text = `🎤 ${d.label || `Microphone ${inputSelect.options.length + 1}`}`; // Icon added
                inputSelect.appendChild(opt);
            });
            inputSelect.addEventListener('change', async (e) => {
                const newStream = await this.audio.changeInputDevice(e.target.value);
                // Dispatch event to notify peers of new stream if necessary (logic in App)
                document.dispatchEvent(new CustomEvent('local-stream-changed', { detail: { stream: newStream } }));
            });
        }

        if (outputSelect) {
            // Check if setSinkId is supported for output selection
            if (!('setSinkId' in HTMLMediaElement.prototype)) {
                outputSelect.parentElement.style.display = 'none';
                return;
            }

            const outputs = devices.filter(d => d.kind === 'audiooutput');
            // Clear existing
            outputSelect.innerHTML = '';

            outputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.text = `🎧 ${d.label || `Haut-parleur ${outputSelect.options.length + 1}`}`; // Icon added
                outputSelect.appendChild(opt);
            });
            outputSelect.addEventListener('change', (e) => {
                this.audio.setSinkId(id, e.target.value);
            });
        }
    }

    addChatMessage(text, author, isSystem = false) {
        const div = document.createElement('div');
        div.className = `message ${isSystem ? 'system' : ''}`;

        if (isSystem) {
            div.textContent = text;
        } else {
            div.innerHTML = `<span class="author">${author}:</span> ${text}`;
        }

        this.chatMessages.appendChild(div);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }
}
