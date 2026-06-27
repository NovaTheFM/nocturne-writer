import re

# 1. FIX MAIN.JS
with open('src/main.js', 'r', encoding='utf-8') as f:
    js = f.read()

# Find the bad injection and replace it
bad_injection = r"\$\{row\('Экспериментальный дизайн', 'Включает ультра-хайповый детализированный UI \(Glassmorphism, 3D\)\.', toggle\('experimentalDesign'\)\)\}"
good_html = """<div class="setting-row">
        <div class="setting-info">
          <span>Экспериментальный дизайн</span>
          <small>Включает ультра-хайповый детализированный UI (Парящие панели, 3D, живой фон).</small>
        </div>
        <div class="setting-control">
          <div class="toggle ${this.state.settings.experimentalDesign ? 'on' : ''}" data-setting="experimentalDesign" data-kind="toggle"></div>
        </div>
      </div>"""

js = re.sub(bad_injection, good_html, js)

with open('src/main.js', 'w', encoding='utf-8') as f:
    f.write(js)

# 2. CREATE EXPERIMENTAL.CSS
css_content = """/* 
   ================================================
   EXPERIMENTAL DESIGN: UNLEASHED
   ================================================
   Activated via Settings -> Misc -> Experimental Design.
   This is a complete architectural overhaul.
*/

/* 1. Global Reset & Ambient Glow Background */
body.theme-experimental {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
  background-color: #000 !important;
  overflow: hidden;
}

body.theme-experimental::before,
body.theme-experimental::after {
  content: '';
  position: fixed;
  width: 60vw;
  height: 60vw;
  border-radius: 50%;
  filter: blur(140px);
  z-index: -2;
  opacity: 0.15;
  pointer-events: none;
  animation: exp-orb-float 20s infinite alternate ease-in-out;
}

body.theme-experimental::before {
  top: -20vh;
  left: -20vw;
  background: var(--accent);
}

body.theme-experimental::after {
  bottom: -20vh;
  right: -20vw;
  background: var(--color-success, #34d399);
  animation-delay: -10s;
}

@keyframes exp-orb-float {
  0% { transform: translate(0, 0) scale(1); }
  100% { transform: translate(20vw, 10vh) scale(1.5); }
}

/* 2. Floating Islands (Detached UI) */
.theme-experimental #app {
  display: flex;
  gap: 16px;
  padding: 16px;
  height: 100vh;
  box-sizing: border-box;
}

/* Base style for all major panels */
.theme-experimental .sidebar,
.theme-experimental .mobile-panel,
.theme-experimental .review-panel,
.theme-experimental .workspace {
  background: rgba(18, 18, 22, 0.4) !important;
  backdrop-filter: blur(40px) saturate(200%);
  -webkit-backdrop-filter: blur(40px) saturate(200%);
  border: 1px solid rgba(255, 255, 255, 0.08) !important;
  border-radius: 24px !important;
  box-shadow: 0 30px 60px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
  height: calc(100vh - 32px) !important;
  overflow: hidden;
}

.theme-experimental .navbar {
  background: transparent !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important;
}

.theme-experimental .app-content {
  border-radius: 24px;
}

/* 3. The Monolithic Editor Page */
.theme-experimental .editor-container {
  background: transparent !important;
  padding: 40px !important;
}

.theme-experimental .page {
  background: rgba(22, 22, 26, 0.6) !important;
  backdrop-filter: blur(50px) saturate(150%);
  border: 1px solid rgba(255, 255, 255, 0.06) !important;
  border-radius: 16px !important;
  box-shadow: 0 40px 80px rgba(0, 0, 0, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.05) !important;
  transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1) !important;
  transform-origin: center top;
}

.theme-experimental .page:focus-within {
  box-shadow: 0 50px 100px rgba(0, 0, 0, 0.8), 0 0 80px rgba(var(--accent-rgb, 139, 92, 246), 0.15) !important;
  transform: translateY(-4px) scale(1.005) !important;
  border-color: rgba(255, 255, 255, 0.15) !important;
}

/* 4. Hyper-Tactile Cards */
.theme-experimental .loc-card,
.theme-experimental .char-card,
.theme-experimental .doc-card,
.theme-experimental .timeline-event {
  background: rgba(26, 26, 34, 0.5) !important;
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.05) !important;
  border-radius: 16px !important;
  transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
  transform-style: preserve-3d;
}

.theme-experimental .loc-card:hover,
.theme-experimental .char-card:hover,
.theme-experimental .doc-card:hover,
.theme-experimental .timeline-event:hover {
  transform: translateY(-8px) scale(1.03) !important;
  background: rgba(36, 36, 48, 0.8) !important;
  border-color: var(--accent) !important;
  box-shadow: 0 25px 50px rgba(0,0,0,0.5), 0 0 20px var(--accent-glow) !important;
}

/* 5. Fluid Buttons */
.theme-experimental .btn-primary,
.theme-experimental .pill-btn.active {
  background: linear-gradient(135deg, var(--accent), var(--accent-hover)) !important;
  box-shadow: 0 8px 20px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.3) !important;
  border: none !important;
  border-radius: 12px !important;
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1) !important;
}

.theme-experimental .btn-primary:hover,
.theme-experimental .pill-btn.active:hover {
  transform: translateY(-3px) scale(1.05) !important;
  box-shadow: 0 12px 30px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.4) !important;
  filter: brightness(1.2);
}

/* 6. Settings Modal as a floating frosted glass */
.theme-experimental .settings-modal {
  border-radius: 32px !important;
  overflow: hidden;
  background: rgba(15, 15, 20, 0.75) !important;
  box-shadow: 0 50px 100px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.1) !important;
}

.theme-experimental .settings-tab {
  border-radius: 12px !important;
  margin: 4px 8px !important;
  transition: all 0.2s !important;
}

.theme-experimental .settings-tab.active {
  background: var(--accent-glow) !important;
  color: var(--text-main) !important;
  box-shadow: inset 0 0 0 1px var(--accent) !important;
}

/* 7. Typography overrides */
.theme-experimental h1,
.theme-experimental h2,
.theme-experimental h3 {
  letter-spacing: -0.02em;
  font-weight: 600;
}
"""

with open('src/css/experimental.css', 'w', encoding='utf-8') as f:
    f.write(css_content)

print("Preloader fix and experimental CSS applied.")
