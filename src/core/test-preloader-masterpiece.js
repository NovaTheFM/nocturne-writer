/**
 * Nocturne Lunar Quill & Ink Bloom Preloader Engine (v6.0)
 * 
 * Powered by Three.js WebGL Graphics (src/vendor/three/three.module.js)
 * 
 * Core Features:
 * 1. WebGL Lunar Eclipse Corona Ring (3D stardust halo + rotating crescent lighting)
 * 2. Liquid Ink-in-Water Diffusion Physics (organically expanding volumetric ink clouds)
 * 3. Interactive Cursor Ink Drops (clicking & moving drops liquid ink clouds into dark water)
 * 4. Poetic Chapter Status Sequence (Literary status progression with Lora serif typography)
 * 5. Golden Circular 360° Hairline Progress Arc
 * 6. Atmospheric Dissolve Exit Transition
 */

import THREE from '../vendor/three/three.module.js';

export class MasterpiecePreloader {
  constructor(options = {}) {
    this.container = options.container || null;
    this.targetProgress = 0;
    this.currentProgress = 0;
    this.animFrameId = null;
    this.isExiting = false;
    this.onComplete = options.onComplete || null;

    // Three.js Core Objects
    this.scene = null;
    this.camera = null;
    this.renderer = null;

    // Lunar Ring & Ink Clouds State
    this.lunarGroup = null;
    this.lunarRingMesh = null;
    this.coronaParticles = null;
    this.inkClouds = [];

    // Mouse & Fluid Physics State
    this.mouse = { x: 0, y: 0, normX: 0, normY: 0, active: false };
    this.time = 0;
    this.lastFrameTime = performance.now();
    this.fps = 60;

    // Poetic Chapter Statuses
    this.chapters = [
      { min: 0, max: 25, title: 'ГЛАВА I', text: 'Тень сумерек опускается на страницы...' },
      { min: 25, max: 55, title: 'ГЛАВА II', text: 'Пробуждение черновиков и карточек мира...' },
      { min: 55, max: 85, title: 'ГЛАВА III', text: 'Чернила мягко ложатся на пергамент...' },
      { min: 85, max: 100, title: 'ГЛАВА IV', text: 'Творческое пространство полностью готово.' }
    ];
    this.currentChapterIndex = 0;
  }

  mount(targetParent = document.body) {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.id = 'cosmic-preloader';
    this.container.className = 'cosmic-preloader-overlay lunar-ink-mode';
    this.container.innerHTML = `
      <div class="lunar-canvas-wrap" id="lunar-canvas-wrap"></div>
      <div class="lunar-ambient-spotlight"></div>

      <!-- Lunar Stage & Typography Overlay -->
      <div class="lunar-stage-overlay">
        
        <!-- Top Brand Header -->
        <div class="lunar-header-row">
          <div class="lunar-brand-group">
            <div class="lunar-emblem-feather"></div>
            <span class="lunar-brand-title">NOCTURNE WRITER</span>
          </div>
          <span class="lunar-fps-counter" id="lunar-fps">60 FPS</span>
        </div>

        <!-- Center Lunar Eclipse & Progress Arc Target -->
        <div class="lunar-center-stage">
          <div class="lunar-progress-ring-wrap">
            <svg class="lunar-progress-svg" viewBox="0 0 220 220" width="220" height="220">
              <circle class="lunar-track-circle" cx="110" cy="110" r="100"></circle>
              <circle class="lunar-fill-circle" id="lunar-fill-circle" cx="110" cy="110" r="100"></circle>
            </svg>
            <div class="lunar-center-percent" id="cosmic-percent">0%</div>
          </div>
        </div>

        <!-- Bottom Poetic Chapter Status -->
        <div class="lunar-chapter-box">
          <div class="lunar-chapter-badge" id="lunar-chapter-badge">ГЛАВА I</div>
          <div class="lunar-chapter-text-wrap">
            <span class="lunar-chapter-text" id="cosmic-status-text">Тень сумерек опускается на страницы...</span>
          </div>
        </div>

      </div>
    `;
    targetParent.appendChild(this.container);

    // Force layout reflow before applying active entrance class
    void this.container.offsetWidth;
    requestAnimationFrame(() => {
      if (this.container) this.container.classList.add('active');
    });

    this.initThreeJS();
    this.bindEvents();
    this.startLoop();
  }

  initThreeJS() {
    const wrap = this.container.querySelector('#lunar-canvas-wrap');
    if (!wrap) return;

    const w = window.innerWidth;
    const h = window.innerHeight;

    // 1. Three.js Scene & Camera
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);
    this.camera.position.set(0, 0, 8);

    // 2. WebGL Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    wrap.appendChild(this.renderer.domElement);

    const accentHexStr = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8b5cf6';
    const accentColor = new THREE.Color(accentHexStr);

    // 3. Ambient & Point Lights
    const ambient = new THREE.AmbientLight(0x120f24, 2.5);
    this.scene.add(ambient);

    const light = new THREE.PointLight(accentColor, 4, 20);
    light.position.set(0, 0, 3);
    this.scene.add(light);

    // 4. Create Lunar Eclipse Ring Group
    this.lunarGroup = new THREE.Group();
    this.scene.add(this.lunarGroup);

    // Outer Ring Mesh
    const ringGeo = new THREE.RingGeometry(1.65, 1.72, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: accentColor,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.65
    });
    this.lunarRingMesh = new THREE.Mesh(ringGeo, ringMat);
    this.lunarGroup.add(this.lunarRingMesh);

    // Inner Glowing Lunar Disc
    const innerGeo = new THREE.CircleGeometry(1.64, 64);
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0x090714,
      transparent: true,
      opacity: 0.95
    });
    const innerDisc = new THREE.Mesh(innerGeo, innerMat);
    innerDisc.position.z = -0.01;
    this.lunarGroup.add(innerDisc);

    // Stardust Corona Particle Halo
    this.createStardustCorona(accentColor);

    // Initialize initial Volumetric Ink Bloom particles
    this.spawnInitialInkClouds(accentColor);
  }

  createStardustCorona(accentColor) {
    const count = 350;
    const positions = new Float32Array(count * 3);

    for (let i = 0; i < count; i += 1) {
      const radius = 1.75 + Math.random() * 1.8;
      const angle = Math.random() * Math.PI * 2;

      positions[i * 3] = radius * Math.cos(angle);
      positions[i * 3 + 1] = radius * Math.sin(angle);
      positions[i * 3 + 2] = (Math.random() - 0.5) * 0.8;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: accentColor,
      size: 0.055,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending
    });

    this.coronaParticles = new THREE.Points(geo, mat);
    this.lunarGroup.add(this.coronaParticles);
  }

  spawnInitialInkClouds(accentColor) {
    // Spawn 16 volumetric liquid ink clouds in dark water
    for (let i = 0; i < 16; i += 1) {
      this.dropInkCloud(
        (Math.random() - 0.5) * 5,
        (Math.random() - 0.5) * 3.5,
        accentColor,
        Math.random() * 0.6 + 0.4
      );
    }
  }

  dropInkCloud(x, y, color, scale = 0.5) {
    const geo = new THREE.CircleGeometry(scale, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, (Math.random() - 0.5) * 2 - 1);
    this.scene.add(mesh);

    this.inkClouds.push({
      mesh,
      expansionRate: Math.random() * 0.003 + 0.001,
      fadeRate: Math.random() * 0.0015 + 0.0005,
      currentScale: scale,
      currentOpacity: 0.25
    });
  }

  bindEvents() {
    this.resizeHandler = () => {
      if (!this.renderer || !this.camera) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };
    window.addEventListener('resize', this.resizeHandler);

    this.mouseMoveHandler = (e) => {
      this.mouse.active = true;
      // Convert screen coords to 3D world space
      this.mouse.normX = (e.clientX / window.innerWidth - 0.5) * 7;
      this.mouse.normY = -(e.clientY / window.innerHeight - 0.5) * 5;
    };
    window.addEventListener('mousemove', this.mouseMoveHandler);

    this.clickHandler = (e) => {
      const accentHexStr = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8b5cf6';
      const accentColor = new THREE.Color(accentHexStr);
      // Drop organic liquid ink bloom on click
      this.dropInkCloud(this.mouse.normX, this.mouse.normY, accentColor, Math.random() * 0.7 + 0.5);
    };
    this.container.addEventListener('click', this.clickHandler);
  }

  setProgress(targetPct, statusMessage = null) {
    this.targetProgress = Math.min(100, Math.max(0, targetPct));
    this.updateChapter(targetPct);
  }

  updateChapter(pct) {
    let matchedIndex = 0;
    for (let i = 0; i < this.chapters.length; i += 1) {
      if (pct >= this.chapters[i].min) {
        matchedIndex = i;
      }
    }

    if (matchedIndex !== this.currentChapterIndex) {
      this.currentChapterIndex = matchedIndex;
      const ch = this.chapters[matchedIndex];

      const badge = this.container?.querySelector('#lunar-chapter-badge');
      const text = this.container?.querySelector('#cosmic-status-text');

      if (badge) badge.innerText = ch.title;
      if (text) {
        text.style.opacity = '0';
        text.style.transform = 'translateY(5px)';
        setTimeout(() => {
          text.innerText = ch.text;
          text.style.opacity = '1';
          text.style.transform = 'translateY(0)';
        }, 140);
      }
    }
  }

  startLoop() {
    const fillCircle = this.container?.querySelector('#lunar-fill-circle');
    const percentEl = this.container?.querySelector('#cosmic-percent');
    const fpsEl = this.container?.querySelector('#lunar-fps');

    const circumference = 2 * Math.PI * 100; // ~628.3

    if (fillCircle) {
      fillCircle.style.strokeDasharray = `${circumference}`;
      fillCircle.style.strokeDashoffset = `${circumference}`;
    }

    const loop = (timestamp) => {
      // Calculate FPS
      const delta = timestamp - this.lastFrameTime;
      this.lastFrameTime = timestamp;
      if (delta > 0) {
        const currentFps = Math.round(1000 / delta);
        this.fps = Math.round(this.fps * 0.9 + currentFps * 0.1);
      }

      this.time += 0.016;

      // 1. Lerp Progress Engine (0.04)
      const diff = this.targetProgress - this.currentProgress;
      if (Math.abs(diff) > 0.01) {
        this.currentProgress += diff * 0.04;
      } else {
        this.currentProgress = this.targetProgress;
      }

      const displayPct = Math.round(this.currentProgress);

      if (fillCircle) {
        const offset = circumference - (this.currentProgress / 100) * circumference;
        fillCircle.style.strokeDashoffset = `${offset.toFixed(1)}`;
      }
      if (percentEl) percentEl.innerText = `${displayPct}%`;
      if (fpsEl) fpsEl.innerText = `${Math.min(120, this.fps)} FPS`;

      // 2. Rotate Lunar Eclipse Corona
      if (this.lunarGroup) {
        this.lunarGroup.rotation.z = this.time * 0.15;
      }
      if (this.coronaParticles) {
        this.coronaParticles.rotation.z = -this.time * 0.25;
      }

      // 3. Camera Parallax Spring Interpolation
      if (this.camera && this.mouse.active) {
        this.camera.position.x += (this.mouse.normX * 0.15 - this.camera.position.x) * 0.05;
        this.camera.position.y += (this.mouse.normY * 0.15 - this.camera.position.y) * 0.05;
        this.camera.lookAt(0, 0, 0);
      }

      // 4. Update Volumetric Liquid Ink Bloom Clouds
      const len = this.inkClouds.length;
      for (let i = len - 1; i >= 0; i -= 1) {
        const cloud = this.inkClouds[i];
        cloud.currentScale += cloud.expansionRate;
        cloud.currentOpacity -= cloud.fadeRate;

        cloud.mesh.scale.set(cloud.currentScale, cloud.currentScale, 1);
        cloud.mesh.material.opacity = Math.max(0, cloud.currentOpacity);

        // Remove fully faded clouds
        if (cloud.currentOpacity <= 0) {
          this.scene.remove(cloud.mesh);
          cloud.mesh.geometry.dispose();
          cloud.mesh.material.dispose();
          this.inkClouds.splice(i, 1);
        }
      }

      // Render WebGL Scene
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
      }

      if (this.container && (this.container.classList.contains('active') || !this.isExiting)) {
        this.animFrameId = requestAnimationFrame(loop);
      }
    };

    loop(performance.now());
  }

  destroy() {
    if (this.isExiting) return;
    this.isExiting = true;
    if (this.container) {
      this.container.classList.remove('active');
      this.container.classList.add('exiting');

      setTimeout(() => {
        if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
        if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
        if (this.mouseMoveHandler) window.removeEventListener('mousemove', this.mouseMoveHandler);

        // Clean up ink clouds & Three.js geometries
        this.inkClouds.forEach(c => {
          this.scene.remove(c.mesh);
          c.mesh.geometry.dispose();
          c.mesh.material.dispose();
        });
        if (this.renderer) this.renderer.dispose();

        this.container?.remove();
        this.container = null;
        if (this.onComplete) this.onComplete();
      }, 750);
    }
  }
}
