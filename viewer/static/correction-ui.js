/**
 * Shared Correction UI Module
 * Provides a consistent correction experience across the application.
 */
const MAPY_CZ_API_KEY = "JToxKFIPuYBZVmm3P8Kjujtg4wUEhzeP3TIBNcKxRV0";

(() => {
    const CorrectionUI = {
        map: null,
        marker: null,
        originalCoords: null,
        proposedCoords: null,
        containerEl: null,
        mapEl: null,
        submitBtn: null,
        cancelBtn: null,
        messageEl: null,
        emailEl: null,
        statusEl: null,
        turnstileContainerEl: null,
        turnstileNoteEl: null,
        turnstileWidgetId: null,
        turnstileToken: "",
        turnstileBypass: false,
        turnstileSiteKey: "",
        onSubmit: null,
        onCancel: null,
        feature: null,

        /**
         * Initialize the Correction UI.
         * @param {Object} options
         * @param {HTMLElement} options.container - The container element for the correction UI.
         * @param {HTMLElement} options.mapEl - The map container element.
         * @param {HTMLElement} options.submitBtn - The submit button.
         * @param {HTMLElement} options.cancelBtn - The cancel button.
         * @param {HTMLElement} options.messageEl - The message textarea.
         * @param {HTMLElement} options.emailEl - The email input.
         * @param {HTMLElement} options.statusEl - The status message element.
         * @param {HTMLElement} options.turnstileContainerEl - The Turnstile container element.
         * @param {HTMLElement} options.turnstileNoteEl - The Turnstile note element.
         * @param {string} options.turnstileSiteKey - The Turnstile site key.
         * @param {boolean} options.turnstileBypass - Whether to bypass Turnstile (dev mode).
         * @param {Function} options.onSubmit - Callback after successful submission (feature, proposedCoords).
         * @param {Function} options.onCancel - Callback when cancel is clicked.
         */
        init(options) {
            this.containerEl = options.container;
            this.mapEl = options.mapEl;
            this.submitBtn = options.submitBtn;
            this.cancelBtn = options.cancelBtn;
            this.messageEl = options.messageEl;
            this.emailEl = options.emailEl;
            this.statusEl = options.statusEl;
            this.turnstileContainerEl = options.turnstileContainerEl;
            this.turnstileNoteEl = options.turnstileNoteEl;
            this.turnstileSiteKey = options.turnstileSiteKey || "";
            this.turnstileBypass = options.turnstileBypass || false;
            this.onSubmit = options.onSubmit || (() => { });
            this.onCancel = options.onCancel || (() => { });

            if (this.submitBtn) {
                this.submitBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    this.submit();
                });
            }
            if (this.cancelBtn) {
                this.cancelBtn.addEventListener("click", () => {
                    this.close();
                    this.onCancel();
                });
            }

            this.renderTurnstile();
        },

        ensureMap() {
            if (this.map) return;
            if (!this.mapEl) return;

            this.map = L.map(this.mapEl, {
                center: [50.08, 14.43],
                zoom: 15,
                zoomControl: true,
            });

            const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
            const mapyAttr = '&copy; <a href="https://www.mapy.cz">Mapy.cz</a>';

            if (MAPY_CZ_API_KEY) {
                const mapyLayer = L.tileLayer(`https://api.mapy.cz/v1/maptiles/basic/256/{z}/{x}/{y}?apikey=${MAPY_CZ_API_KEY}`, {
                    maxZoom: 19,
                    attribution: `${mapyAttr}, ${osmAttr}`
                });
                mapyLayer.addTo(this.map);
                let fallbackActive = false;
                mapyLayer.on('tileerror', () => {
                    if (fallbackActive) return;
                    fallbackActive = true;
                    this.map.removeLayer(mapyLayer);
                    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
                        maxZoom: 19,
                        attribution: osmAttr,
                    }).addTo(this.map);
                });
            } else {
                L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
                    maxZoom: 19,
                    attribution: osmAttr,
                }).addTo(this.map);
            }

            this.map.on("click", (event) => {
                const { lat, lng } = event.latlng;
                this.setProposedCoords(lat, lng);
            });
        },

        /**
         * Open the correction UI for a specific feature.
         * @param {Object} feature - The GeoJSON feature.
         */
        open(feature) {
            this.feature = feature;
            this.proposedCoords = null;
            this.clearStatus();

            if (this.messageEl) this.messageEl.value = "";
            if (this.emailEl) this.emailEl.value = "";

            const [lon, lat] = feature.geometry.coordinates;
            this.originalCoords = { lat, lon };

            // Show container BEFORE creating map so it has dimensions
            if (this.containerEl) this.containerEl.classList.remove("is-hidden");

            this.ensureMap();

            if (this.marker) {
                this.map.removeLayer(this.marker);
                this.marker = null;
            }

            this.marker = L.marker([lat, lon], { draggable: true }).addTo(this.map);
            this.marker.on("dragend", () => {
                const pos = this.marker.getLatLng();
                this.setProposedCoords(pos.lat, pos.lng);
            });

            this.map.setView([lat, lon], 17);

            // Use requestAnimationFrame for better timing
            requestAnimationFrame(() => {
                setTimeout(() => {
                    if (this.map) this.map.invalidateSize();
                }, 150);
            });

            this.updateSubmitState();
        },

        /**
         * Close the correction UI.
         */
        close() {
            if (this.marker && this.map) {
                this.map.removeLayer(this.marker);
                this.marker = null;
            }
            this.proposedCoords = null;
            this.feature = null;
            this.clearStatus();
            if (this.containerEl) this.containerEl.classList.add("is-hidden");
        },

        setProposedCoords(lat, lon) {
            this.proposedCoords = { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
            if (this.marker) {
                this.marker.setLatLng([lat, lon]);
            }
            this.updateSubmitState();
        },

        updateSubmitState() {
            const hasToken = !!(this.turnstileToken || this.turnstileBypass);
            const hasProposed = !!this.proposedCoords;
            if (this.submitBtn) {
                this.submitBtn.disabled = !hasProposed || !hasToken;
            }
        },

        setStatus(message, type) {
            if (!this.statusEl) return;
            this.statusEl.textContent = message;
            this.statusEl.className = "form-status";
            if (type) this.statusEl.classList.add(`is-${type}`);
        },

        clearStatus() {
            if (this.statusEl) {
                this.statusEl.textContent = "";
                this.statusEl.className = "form-status";
            }
        },

        renderTurnstile() {
            if (this.turnstileBypass) {
                if (this.turnstileNoteEl) this.turnstileNoteEl.textContent = "Turnstile je vypnutý pro lokální vývoj.";
                this.updateSubmitState();
                return;
            }

            if (!window.turnstile || !this.turnstileSiteKey || !this.turnstileContainerEl) {
                if (this.turnstileNoteEl && !this.turnstileSiteKey) {
                    this.turnstileNoteEl.textContent = "Chybí Turnstile klíč.";
                }
                return;
            }

            if (this.turnstileWidgetId !== null) return;

            this.turnstileWidgetId = window.turnstile.render(this.turnstileContainerEl, {
                sitekey: this.turnstileSiteKey,
                callback: (token) => {
                    this.turnstileToken = token;
                    this.updateSubmitState();
                },
                "expired-callback": () => {
                    this.turnstileToken = "";
                    this.updateSubmitState();
                },
                "error-callback": () => {
                    this.turnstileToken = "";
                    this.updateSubmitState();
                },
            });
        },

        async submit() {
            if (!this.feature || !this.proposedCoords) {
                this.setStatus("Nejprve vyberte bod na mapě.", "error");
                return;
            }

            if (!this.turnstileToken && !this.turnstileBypass) {
                this.setStatus("Dokončete Turnstile kontrolu.", "error");
                return;
            }

            const payload = {
                xid: this.feature.properties.id,
                lat: this.proposedCoords.lat,
                lon: this.proposedCoords.lon,
                verdict: "wrong",
                message: (this.messageEl?.value || "").trim() || "Nahlášena špatná poloha.",
                email: (this.emailEl?.value || "").trim() || null,
                token: this.turnstileToken || "",
            };

            if (this.submitBtn) this.submitBtn.disabled = true;

            try {
                const response = await fetch("/api/corrections", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });

                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    throw new Error(error.detail || "Odeslání selhalo");
                }

                this.setStatus("Díky! Oprava byla uložena.", "success");
                this.turnstileToken = "";
                if (this.turnstileWidgetId !== null && window.turnstile) {
                    window.turnstile.reset(this.turnstileWidgetId);
                }
                this.onSubmit(this.feature, this.proposedCoords);
                setTimeout(() => this.close(), 500);
            } catch (error) {
                this.setStatus(error.message || "Odeslání selhalo", "error");
                this.updateSubmitState();
            }
        },
    };

    window.CorrectionUI = CorrectionUI;
})();
