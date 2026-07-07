// ============================================================
// MONARCH WEALTH GROUP — DYNAMIC FOMO ENGINE
// Live counters, rolling numbers, spot tracking, auto-refresh
// ============================================================

(function() {
    'use strict';

    // ── Live Member Counter ──────────────────────────────────
    function initLiveCounter() {
        const el = document.getElementById('liveMembers');
        if (!el) return;
        
        let count = parseInt(el.textContent.replace(/[,\s]/g, '')) || 14247;
        const step = () => {
            if (Math.random() > 0.6) {
                const increment = Math.floor(Math.random() * 4) + 1;
                count += increment;
                el.textContent = count.toLocaleString();
                el.classList.remove('counter-flash');
                void el.offsetWidth;
                el.classList.add('counter-flash');
            }
        };
        setInterval(step, 5000);
    }

    // ── FOMO Spot Counter ───────────────────────────────────
    function initSpotCounter() {
        const el = document.getElementById('fomoSpotsLeft');
        if (!el) return;

        function fetchSpots() {
            fetch('/api/waiting-list/spots')
                .then(r => r.json())
                .then(data => {
                    if (data.success && data.spots_left !== undefined) {
                        const prev = parseInt(el.textContent) || data.spots_left;
                        el.textContent = data.spots_left;
                        if (data.spots_left < prev) {
                            el.classList.remove('spot-flash');
                            void el.offsetWidth;
                            el.classList.add('spot-flash');
                        }
                    }
                })
                .catch(() => {});
        }

        fetchSpots();
        setInterval(fetchSpots, 30000);
    }

    // ── FOMO Queue Counter ──────────────────────────────────
    function initQueueCounter() {
        const el = document.getElementById('fomoQueueCount');
        if (!el) return;

        let baseCount = parseInt(el.textContent) || 127;
        const step = () => {
            if (Math.random() > 0.5) {
                baseCount += Math.floor(Math.random() * 3) + 1;
                el.textContent = baseCount;
            }
        };
        setInterval(step, 8000);
    }

    // ── Rolling Money Counter (Dashboard) ────────────────────
    function initRollingMoney() {
        const el = document.getElementById('rollingPortfolio');
        if (!el) return;

        let currentValue = parseFloat(el.textContent.replace(/[$,]/g, '')) || 0;

        setInterval(() => {
            const growth = currentValue * (Math.random() * 1.8 + 0.2) / 100;
            const newValue = currentValue + growth;
            
            // Animate the number change
            const startValue = currentValue;
            const duration = 900;
            const startTime = performance.now();

            function animate(now) {
                const elapsed = now - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 3);
                const current = startValue + (newValue - startValue) * eased;
                el.textContent = '$' + current.toFixed(2);

                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    currentValue = newValue;
                }
            }
            requestAnimationFrame(animate);
        }, 3000);
    }

    // ── Dynamic Chart Auto-Update ────────────────────────────
    function initDynamicChart() {
        const svg = document.getElementById('dynamicChart');
        if (!svg) return;

        function updateChart() {
            const path = svg.querySelector('polyline');
            const points = svg.getAttribute('data-points');
            if (!points) return;

            const arr = points.split(',').map(Number);
            const last = arr[arr.length - 1];
            // Shift and add new point
            arr.shift();
            const change = last * (Math.random() * 0.04 - 0.02);
            arr.push(last + change);
            svg.setAttribute('data-points', arr.join(','));

            // Recalculate path
            const min = Math.min(...arr);
            const max = Math.max(...arr);
            const width = svg.viewBox.baseVal.width || 320;
            const height = svg.viewBox.baseVal.height || 160;
            const padding = 18;
            const pathPoints = arr.map((v, i) => {
                const x = padding + (i / (arr.length - 1)) * (width - padding * 2);
                const y = height - padding - ((v - min) / Math.max(1, max - min)) * (height - padding * 2);
                return `${x},${y}`;
            }).join(' ');

            if (path) path.setAttribute('points', pathPoints);

            // Update area
            const area = svg.querySelector('path.area');
            if (area) {
                const areaPath = `M${padding},${height - padding} L${pathPoints} L${width - padding},${height - padding} Z`;
                area.setAttribute('d', areaPath);
            }

            // Update last dot
            const dot = svg.querySelector('circle');
            if (dot) {
                const lastCoords = pathPoints.split(' ').pop().split(',');
                dot.setAttribute('cx', lastCoords[0]);
                dot.setAttribute('cy', lastCoords[1]);
            }

            // Update return label
            const returnEl = document.getElementById('chartReturn');
            if (returnEl) {
                const first = arr[0];
                const lastVal = arr[arr.length - 1];
                const pct = first > 0 ? ((lastVal - first) / first) * 100 : 0;
                returnEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
            }
        }

        setInterval(updateChart, 5000);
    }

    // ── Withdrawal Countdown Timer ───────────────────────────
    function initWithdrawalCountdown() {
        const el = document.getElementById('withdrawalCountdown');
        if (!el) return;

        const targetStr = el.getAttribute('data-target');
        const target = targetStr ? new Date(targetStr) : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);

        function tick() {
            const now = new Date();
            const diff = target - now;
            if (diff <= 0) {
                el.textContent = 'Processing Now';
                return;
            }
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const secs = Math.floor((diff % (1000 * 60)) / 1000);
            const secClass = secs < 10 ? 'countdown-seconds' : '';
            el.innerHTML = `
                <span style="font-size:1.5rem;">${String(days).padStart(2,'0')}d</span>
                <span style="font-size:1.5rem;">${String(hours).padStart(2,'0')}h</span>
                <span style="font-size:1.5rem;">${String(mins).padStart(2,'0')}m</span>
                <span style="font-size:1.5rem;" class="${secClass}">${String(secs).padStart(2,'0')}s</span>
            `;
        }

        tick();
        setInterval(tick, 1000);
    }

    // ── Auto-Rotating Success Stories ────────────────────────
    function initSuccessStories() {
        const container = document.getElementById('successStories');
        if (!container) return;

        const stories = JSON.parse(container.getAttribute('data-stories') || '[]');
        if (stories.length === 0) return;

        let index = 0;
        function showNext() {
            index = (index + 1) % stories.length;
            const story = stories[index];
            container.innerHTML = `
                <div class="story-fade" style="text-align:center;">
                    <div style="font-size:2.5rem;margin-bottom:0.5rem;">${story.icon || '⭐'}</div>
                    <p style="font-style:italic;color:var(--text-secondary);font-size:0.95rem;line-height:1.6;max-width:500px;margin:0 auto;">"${story.text}"</p>
                    <div style="margin-top:0.8rem;">
                        <strong style="color:var(--gold);">${story.name}</strong>
                        <span style="color:var(--text-tertiary);font-size:0.78rem;"> — ${story.location}</span>
                    </div>
                </div>
            `;
        }

        setInterval(showNext, 15000);
    }

    // ── Initialize all on DOM ready ──────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        initLiveCounter();
        initSpotCounter();
        initQueueCounter();
        initRollingMoney();
        initDynamicChart();
        initWithdrawalCountdown();
        initSuccessStories();
    });
})();
