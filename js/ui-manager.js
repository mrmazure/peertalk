class UIManager {
    constructor(audioEngine) {
        this.audio = audioEngine;
        this.grid = document.getElementById('grid-container');
        this.chatMessages = document.getElementById('chat-messages');
        this.mutedPeers = {}; // peerId -> bool (remote mute state shared by peers)
    }

    // Escape user-controlled strings before injecting into innerHTML (XSS protection)
    escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Trusted "(Hôte)" badge markup (kept as HTML, never escaped)
    hostBadge() {
        return ' <span style="color:var(--primary); font-size:0.8em; font-weight:bold;">(Hôte)</span>';
    }

    createLocalCard(peerId, label) {
        // Check if we are the room host (no hash)
        const isRoomHost = !window.location.hash || window.location.hash === '#';

        const card = this.createCardElement('local', label, true, isRoomHost);
        this.grid.appendChild(card);
        this.setupDeviceSelectors('local');
        this.setupLocalNameEdit('local', isRoomHost);
        this.startVULoop('local');
        this.checkEmptyState();
    }

    // Make the local card name editable: click -> input, Enter/blur -> commit.
    // On commit we update the display, persist the name and broadcast it to peers.
    setupLocalNameEdit(id, isRoomHost) {
        const nameEl = document.getElementById(`name-${id}`);
        if (!nameEl) return;

        nameEl.style.cursor = 'pointer';
        nameEl.title = 'Cliquer pour renommer';

        nameEl.addEventListener('click', () => {
            // Already editing? Ignore re-entry.
            if (nameEl.querySelector('input')) return;

            // Current name, without the trusted "(Hôte)" badge
            const currentName = nameEl.textContent.replace(' (Hôte)', '').replace('(Hôte)', '').trim();

            const input = document.createElement('input');
            input.type = 'text';
            input.value = currentName;
            input.maxLength = 30;
            input.style.cssText = 'width:90%; text-align:center; font-size:1.2rem; padding:2px 6px; ' +
                'border-radius:4px; border:1px solid var(--primary); background:var(--bg-input); color:var(--text-main);';

            nameEl.innerHTML = '';
            nameEl.appendChild(input);
            input.focus();
            input.select();

            let finished = false;
            const finish = (save) => {
                if (finished) return;
                finished = true;

                const newName = save ? (input.value.trim() || currentName) : currentName;

                // Rebuild the name display (escaped) + host badge
                let displayName = this.escapeHtml(newName);
                if (isRoomHost) displayName += this.hostBadge();
                nameEl.innerHTML = displayName;

                // Persist + broadcast only when the name actually changed
                if (save && newName !== currentName) {
                    localStorage.setItem('peerCallName', newName);
                    document.dispatchEvent(new CustomEvent('my-name-changed', { detail: { name: newName } }));
                }
            };

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); finish(true); }
                else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            });
            input.addEventListener('blur', () => finish(true));
        });
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

        // Re-apply any mute state that arrived before this card existed
        if (this.mutedPeers[peerId]) this.setPeerMuted(peerId, true);

        this.checkEmptyState();
    }

    removeCard(peerId) {
        const card = document.getElementById(`card-${peerId}`);
        if (card) card.remove();
        // also remove audio element
        const audio = document.getElementById(`audio-${peerId}`);
        if (audio) audio.remove();

        // Forget any shared mute state for this peer
        delete this.mutedPeers[peerId];

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
                        <div style="font-size: 2rem; margin-bottom: 10px;">➕</div>
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

        // dBFS scale: -60 dB (left) .. 0 dB (right)
        const FLOOR_DB = -60;
        const MARKS = [-60, -40, -20, -6, 0];
        const DECAY_DB_PER_SEC = 12; // peak-hold falls a few dB per second

        // Meter ballistics: time constants (seconds) for the smoothed bar.
        // Fast attack so peaks are caught, slow release so the bar stops trembling.
        // Purely a display filter — no audio is buffered, latency is unchanged.
        const ATTACK_T = 0.05;  // rise toward a louder value
        const RELEASE_T = 0.35; // fall toward a quieter value

        let peakHoldDb = FLOOR_DB;
        let displayRmsDb = FLOOR_DB; // smoothed value actually drawn
        let lastTime = performance.now();

        // Map a dB value to an x pixel position (clamped to the meter range)
        const dbToX = (db, width) => {
            const clamped = Math.max(FLOOR_DB, Math.min(0, db));
            return ((clamped - FLOOR_DB) / (0 - FLOOR_DB)) * width;
        };

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

            // Time delta for peak-hold decay
            const now = performance.now();
            const dt = Math.min(0.25, (now - lastTime) / 1000);
            lastTime = now;

            // RMS + instantaneous peak in dBFS (mono)
            const stats = this.audio.getAudioStats(id);
            const rmsDb = stats.rms;
            const peakDb = stats.peak;

            // Peak-hold: jump up instantly, decay slowly
            if (peakDb > peakHoldDb) {
                peakHoldDb = peakDb;
            } else {
                peakHoldDb = Math.max(FLOOR_DB, peakHoldDb - DECAY_DB_PER_SEC * dt);
            }

            // Smooth the RMS bar with attack/release ballistics (frame-rate independent).
            // This calms the trembling without delaying the audio.
            const tConst = rmsDb > displayRmsDb ? ATTACK_T : RELEASE_T;
            const alpha = 1 - Math.exp(-dt / tConst);
            displayRmsDb += (rmsDb - displayRmsDb) * alpha;

            const muted = !!this.mutedPeers[id];

            // Bar geometry (centered horizontal bar)
            const barHeight = height * 0.6;
            const y = (height - barHeight) / 2;
            const barWidth = dbToX(displayRmsDb, width);

            // Scale reference grid (drawn faint, behind the bar)
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            MARKS.forEach(mark => {
                const mx = Math.min(width - 1, dbToX(mark, width));
                ctx.fillRect(mx, 0, 1, height);
            });

            // Gradient Color (Horizontal): green -> yellow -> red
            const gradient = ctx.createLinearGradient(0, 0, width, 0);
            gradient.addColorStop(0, '#22c55e'); // Green
            gradient.addColorStop(0.6, '#f59e0b'); // Yellow
            gradient.addColorStop(1, '#ef4444'); // Red

            // Grey the meter out when this peer is muted
            ctx.globalAlpha = muted ? 0.25 : 1.0;

            ctx.fillStyle = gradient;
            ctx.fillRect(0, y, barWidth, barHeight);

            // Peak-hold vertical marker
            if (peakHoldDb > FLOOR_DB) {
                const px = Math.min(width - 2, dbToX(peakHoldDb, width));
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(px, y, 2, barHeight);
            }

            ctx.globalAlpha = 1.0;

            // Scale labels (small, only when there's room)
            if (height >= 18) {
                ctx.fillStyle = 'rgba(255,255,255,0.45)';
                ctx.font = '7px system-ui, sans-serif';
                ctx.textBaseline = 'bottom';
                MARKS.forEach(mark => {
                    const mx = dbToX(mark, width);
                    if (mark === FLOOR_DB) {
                        ctx.textAlign = 'left';
                        ctx.fillText(`${mark}`, 1, height - 1);
                    } else if (mark === 0) {
                        ctx.textAlign = 'right';
                        ctx.fillText('0', width - 1, height - 1);
                    } else {
                        ctx.textAlign = 'center';
                        ctx.fillText(`${mark}`, mx, height - 1);
                    }
                });
                ctx.textAlign = 'left'; // reset
            }
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
        // Remove text-based "(Hôte)" if present in name to avoid double labeling if passed,
        // then escape the user-controlled name before injecting it into innerHTML (XSS protection).
        let displayName = this.escapeHtml(name.replace(' (Hôte)', '').replace('(Hôte)', ''));

        if (isRoomHost) {
            displayName += this.hostBadge();
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

            ${!isLocal ? `
            <div class="volume-control">
                <span class="volume-icon" title="Volume">🔊</span>
                <input type="range" id="vol-${id}" class="volume-slider" min="0" max="100" value="100" title="Volume de ce participant">
                <span class="volume-value" id="vol-val-${id}">100%</span>
            </div>
            ` : ''}

            <div class="card-actions" style="display: flex; justify-content: center; padding-top: 10px; width: 100%;">
                <button class="btn btn-secondary btn-mute" title="Couper/Activer le son">MUTE</button>
                ${!isLocal && amIHost ? `<div style="width: 10px;"></div><button class="btn btn-danger btn-eject" title="Éjecter">X</button>` : ''}
            </div>

            ${isLocal ? statusHtml : `
            <div class="status-quality-row" style="display: flex; justify-content: center; align-items: center; gap: 14px; margin-top: 8px; flex-wrap: wrap;">
                <div class="status-container" style="display: flex; align-items: center; gap: 8px;">
                    <span id="status-${id}" class="status-dot"></span>
                    <span id="status-text-${id}" style="font-size: 0.85rem; color: var(--text-muted);">${initialStatusText}</span>
                </div>
                <div class="quality-indicator" id="quality-${id}" title="Qualité de connexion">
                    <span class="quality-dot quality-unknown"></span>
                    <span class="quality-rtt">-- ms</span>
                </div>
            </div>
            `}

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
                // Share our mute state with all peers (handled/broadcast in app.js)
                document.dispatchEvent(new CustomEvent('local-mute-changed', { detail: { muted: isMuted } }));
            } else {
                this.audio.mutePeer(id, isMuted);
            }
        });

        // Per-peer volume fader (remote cards only). Mute (audio.muted) still overrides it.
        if (!isLocal) {
            const volSlider = div.querySelector('.volume-slider');
            const volVal = div.querySelector('.volume-value');
            if (volSlider) {
                volSlider.addEventListener('input', (e) => {
                    const pct = e.target.value;
                    this.audio.setPeerVolume(id, pct / 100);
                    if (volVal) volVal.textContent = `${pct}%`;
                });
            }
        }

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

    // Live link-health indicator: colored dot (good/medium/bad) + RTT, details in tooltip
    updateConnectionQuality(peerId, stats) {
        const el = document.getElementById(`quality-${peerId}`);
        if (!el || !stats) return;

        const { quality, rttMs, lossPct, jitterMs } = stats;
        const dot = el.querySelector('.quality-dot');
        const rttLabel = el.querySelector('.quality-rtt');

        if (dot) dot.className = `quality-dot quality-${quality || 'unknown'}`;

        const hasRtt = rttMs != null && !isNaN(rttMs);
        if (rttLabel) rttLabel.textContent = hasRtt ? `${Math.round(rttMs)} ms` : '-- ms';

        const lossTxt = (typeof lossPct === 'number') ? lossPct.toFixed(1) : '0.0';
        const jitterTxt = (typeof jitterMs === 'number') ? jitterMs.toFixed(1) : '0.0';
        el.title = `Qualité: ${quality || 'inconnue'} · Perte: ${lossTxt}% · Jitter: ${jitterTxt} ms · RTT: ${hasRtt ? Math.round(rttMs) + ' ms' : '--'}`;
    }

    updatePeerName(peerId, name) {
        const el = document.getElementById(`name-${peerId}`);
        if (el) {
            // Check if this peer is the host
            const roomHostId = window.location.hash.substring(1);
            // Escape the user-controlled name before injecting it into innerHTML (XSS protection)
            let displayName = this.escapeHtml(name.replace(' (Hôte)', '').replace('(Hôte)', ''));

            if (roomHostId && peerId === roomHostId) {
                displayName += this.hostBadge();
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

    // Reflect a peer's shared mute state: 🔇 badge on the card + greyed VU meter
    // (the VU loop reads this.mutedPeers[peerId]).
    setPeerMuted(peerId, muted) {
        // Store first so a card created later (stream arriving after metadata) can re-apply it.
        this.mutedPeers[peerId] = !!muted;

        const card = document.getElementById(`card-${peerId}`);
        if (!card) return;

        let badge = document.getElementById(`mute-badge-${peerId}`);
        if (muted) {
            if (!badge) {
                badge = document.createElement('span');
                badge.id = `mute-badge-${peerId}`;
                badge.className = 'mute-badge';
                badge.textContent = '🔇';
                badge.title = 'Micro coupé';
                badge.style.cssText = 'position:absolute; top:8px; right:8px; font-size:1rem;';
                card.appendChild(badge);
            }
        } else if (badge) {
            badge.remove();
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
            // Escape author + text to prevent code execution from a malicious peer
            div.innerHTML = `<span class="author">${this.escapeHtml(author)}:</span> ${this.escapeHtml(text)}`;
        }

        this.chatMessages.appendChild(div);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }
}
