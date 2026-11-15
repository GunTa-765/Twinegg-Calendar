const STORAGE_KEY = 'y_cal';
const NAGOYA = { latitude: 35.1815, longitude: 136.9066 };

let cur = new Date();
let selected = dateKey(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
let schedules = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
let holidays = {};
let temps = {};
let metaAbort = null;

let pickerYear = cur.getFullYear();
let editingPlanIndex = null;
let selectedIconFile = '';
let tempSelectedIconFile = '';
let iconCurrentPage = 1;

// ==========================================================================
// 1. 日付・祝日・気温・六曜ユーティリティ
// ==========================================================================

function pad(n) {
    return String(n).padStart(2, '0');
}

function dateKey(y, m, d) {
    return `${y}-${m}-${d}`;
}

function isoDate(y, m, d) {
    return `${y}-${pad(m)}-${pad(d)}`;
}

function toDateKeyFromIso(iso) {
    const parts = iso.split('-').map(Number);
    return dateKey(parts.at(0), parts.at(1), parts.at(2));
}

function tokyoToday() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { y: get('year'), m: get('month'), d: get('day') };
}

function yesterdayTokyo() {
    const t = tokyoToday();
    const dt = new Date(t.y, t.m - 1, t.d);
    dt.setDate(dt.getDate() - 1);
    return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

function isBeforeYesterdayInclusive(y, m, d, yest) {
    const a = y * 10000 + m * 100 + d;
    const b = yest.y * 10000 + yest.m * 100 + yest.d;
    return a <= b;
}

function nthMonday(y, monthIndex, n) {
    const first = new Date(y, monthIndex, 1);
    const offset = (1 - first.getDay() + 7) % 7;
    return 1 + offset + (n - 1) * 7;
}

function shunbunDay(y) {
    return Math.floor(20.8431 + 0.242194 * (y - 1851) - Math.floor((y - 1851) / 4));
}

function shubunDay(y) {
    return Math.floor(23.2488 + 0.242194 * (y - 1851) - Math.floor((y - 1851) / 4));
}

function computeJapaneseHolidays(y) {
    const raw = {};
    const add = (m, d, name) => { raw[dateKey(y, m, d)] = name; };

    add(1, 1, '元日');
    add(1, nthMonday(y, 0, 2), '成人の日');
    add(2, 11, '建国記念の日');
    add(2, 23, '天皇誕生日');
    add(3, shunbunDay(y), '春分の日');
    add(4, 29, '昭和の日');
    add(5, 3, '憲法記念日');
    add(5, 4, 'みどりの日');
    add(5, 5, 'こどもの日');
    add(7, nthMonday(y, 6, 3), '海の日');
    add(8, 11, '山の日');
    add(9, nthMonday(y, 8, 3), '敬老の日');
    add(9, shubunDay(y), '秋分の日');
    add(10, nthMonday(y, 9, 2), 'スポーツの日');
    add(11, 3, '文化の日');
    add(11, 23, '勤労感謝の日');

    const isHoliday = (m, d) => Boolean(raw[dateKey(y, m, d)]);
    const lastDay = (m) => new Date(y, m, 0).getDate();

    Object.keys(raw).forEach((k) => {
        const parts = k.split('-').map(Number);
        const yy = parts.at(0), mm = parts.at(1), dd = parts.at(2);
        if (new Date(yy, mm - 1, dd).getDay() !== 0) return;
        let m = mm, d = dd + 1;
        while (d > lastDay(m)) {
            d -= lastDay(m);
            m += 1;
            if (m > 12) return;
        }
        while (m <= 12 && isHoliday(m, d)) {
            d += 1;
            if (d > lastDay(m)) {
                d = 1;
                m += 1;
            }
        }
        if (m <= 12 && !isHoliday(m, d)) add(m, d, '振替休日');
    });

    for (let m = 1; m <= 12; m++) {
        for (let d = 2; d < lastDay(m); d++) {
            if (isHoliday(m, d)) continue;
            if (isHoliday(m, d - 1) && isHoliday(m, d + 1)) add(m, d, '国民の休日');
        }
    }

    return raw;
}

function normalizeHolidayMap(data) {
    const out = {};
    Object.keys(data || {}).forEach((iso) => {
        out[toDateKeyFromIso(iso)] = data[iso];
    });
    return out;
}

async function fetchHolidays(y, signal) {
    const url = `https://github.io{y}/date.json?t=${Date.now()}`;
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (!res.ok) throw new Error('holiday fetch failed');
    return normalizeHolidayMap(await res.json());
}

async function fetchTemps(y, monthIndex, signal) {
    const yest = yesterdayTokyo();
    const last = new Date(y, monthIndex + 1, 0).getDate();
    const startOk = isBeforeYesterdayInclusive(y, monthIndex + 1, 1, yest);
    if (!startOk && !isBeforeYesterdayInclusive(y, monthIndex + 1, last, yest)) return {};

    const startDay = 1;
    let endDay = last;
    if (y === yest.y && monthIndex + 1 === yest.m) endDay = yest.d;
    else if (!isBeforeYesterdayInclusive(y, monthIndex + 1, last, yest)) return {};

    const start = isoDate(y, monthIndex + 1, startDay);
    const end = isoDate(y, monthIndex + 1, endDay);
    const bust = Date.now();
    const qs = `latitude=${NAGOYA.latitude}&longitude=${NAGOYA.longitude}&daily=temperature_2m_max,temperature_2m_min&timezone=Asia/Tokyo&start_date=${start}&end_date=${end}&t=${bust}`;

    const urls = Array.of(
        `https://open-meteo.com{qs}`,
        `https://open-meteo.com{qs}`
    );

    let data = null;
    for (const url of urls) {
        try {
            const res = await fetch(url, { signal, cache: 'no-store' });
            if (!res.ok) continue;
            const json = await res.json();
            if (json && json.daily && json.daily.time && json.daily.time.length) {
                data = json;
                break;
            }
        } catch (e) {
            if (e.name === 'AbortError') throw e;
        }
    }
    if (!data) return {};

    const out = {};
    data.daily.time.forEach((iso, i) => {
        const parts = iso.split('-').map(Number);
        const yy = parts.at(0), mm = parts.at(1), dd = parts.at(2);
        if (!isBeforeYesterdayInclusive(yy, mm, dd, yest)) return;
        const maxT = data.daily.temperature_2m_max.at(i);
        const minT = data.daily.temperature_2m_min.at(i);
        if (maxT == null || minT == null) return;
        out[toDateKeyFromIso(iso)] = { max: Number(maxT).toFixed(1), min: Number(minT).toFixed(1) };
    });
    return out;
}

async function refreshMeta() {
    const y = cur.getFullYear();
    const m = cur.getMonth();
    if (metaAbort) metaAbort.abort();
    metaAbort = new AbortController();
    const { signal } = metaAbort;

    holidays = computeJapaneseHolidays(y);
    draw();

    try {
        const results = await Promise.all(Array.of(
            fetchHolidays(y, signal).catch(() => holidays),
            fetchTemps(y, m, signal).catch(() => ({}))
        ));
        if (signal.aborted) return;
        if (cur.getFullYear() !== y || cur.getMonth() !== m) return;
        holidays = results.at(0);
        temps = results.at(1);
        draw();
    } catch (e) {
        if (e.name === 'AbortError') return;
    }
}

function tempHtml(k) {
    const t = temps[k];
    if (!t) return '';
    return `<div class="temp-wrap"><span class="temp-max">${t.max}</span><span class="temp-slash">/</span><span class="temp-min">${t.min}</span></div>`;
}

function getRokuyo(year, month, day) {
    const rokuyoList = Array.of("大安", "赤口", "先勝", "友引", "先負", "仏滅");
    const list2026 = "0,2,2,3,5,0,1,3,4,5,1,2";
    const list2027 = "3,5,5,0,1,3,4,5,0,1,3,4";

    const csv = year === 2027 ? list2027 : list2026;
    const offsets = csv.split(",");
    const yearOffset = Number(offsets.at(month - 1) || 0);
    const index = (day + yearOffset) % 6;

    return rokuyoList.at(index);
}

// ==========================================================================
// 2. カスタムスタンプ管理 ＆ 予定の書式整形
// ==========================================================================

function getFolderIcons() {
    const candidates = Array.of(
        window.CALENDAR_ICONS,
        window.ICONS,
        window.icons,
        window.iconList,
        window.iconFiles,
        window.STAMPS,
        window.stamps
    );
    const found = candidates.find(item => Array.isArray(item) && item.length > 0);
    if (!found) return new Array();

    return found.map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
            return item.file || item.src || item.name || item.path || '';
        }
        return '';
    }).filter(Boolean);
}

function resolveStampSrc(iconValue) {
    if (!iconValue) return '';
    if (iconValue.startsWith('data:image/') || iconValue.startsWith('http') || iconValue.startsWith('image/') || iconValue.startsWith('./image/')) {
        return iconValue;
    }
    return `image/${encodeURIComponent(iconValue)}`;
}

function formatGoogleStylePlan(rawText, isListMode = true) {
    let text = rawText || '';

    // 1. アイコン抽出
    let iconHtml = '';
    const iconMatch = text.match(/^\[icon:(.*?)\]\s*/);
    if (iconMatch) {
        const matchedAll = iconMatch.at(0);
        const iconVal = iconMatch.at(1);
        const src = resolveStampSrc(iconVal);
        if (src) {
            const sizeClass = isListMode ? 'list-plan-icon' : 'cell-plan-icon';
            iconHtml = `<img src="${src}" alt="" class="${sizeClass}">`;
        }
        text = text.replace(matchedAll, '');
    }

    // 2. 時間・終日の抽出
    let timeLabel = '';
    if (text.startsWith('[終日] ')) {
        text = text.replace('[終日] ', '');
        timeLabel = isListMode ? `<span class="gcal-time-badge">終日</span>` : '';
    } else {
        const timeMatch = text.match(/^\[(\d{1,2}:\d{2})～(\d{1,2}:\d{2})?\]\s*/);
        if (timeMatch) {
            const matchedAll = timeMatch.at(0);
            const start = timeMatch.at(1);
            const end = timeMatch.at(2) || '';
            text = text.replace(matchedAll, '');
            if (isListMode) {
                timeLabel = `<span class="gcal-time-text">${end ? `${start} - ${end}` : start}</span>`;
            } else {
                timeLabel = `<span class="gcal-cell-time">${start}</span> `;
            }
        }
    }

    // 3. 説明 (メモ) と 場所 (@場所) の抽出
    let desc = '';
    const descMatch = text.match(/\s+\(([^()]*)\)$/);
    if (descMatch) {
        desc = descMatch.at(1);
        text = text.replace(descMatch.at(0), '');
    }

    let location = '';
    const locMatch = text.match(/\s+@(.*)$/);
    if (locMatch) {
        location = locMatch.at(1);
        text = text.replace(locMatch.at(0), '');
    }

    const title = text.trim();

    if (!isListMode) {
        return `${iconHtml}${timeLabel}<span class="gcal-cell-title">${title}</span>`;
    }

    // 場所とメモを文字化けしないコードで指定
    const locHtml = location ? `<div class="gcal-sub-info">\uD83D\uDCCD ${location}</div>` : '';
    const descHtml = desc ? `<div class="gcal-sub-info gcal-desc">\uD83D\uDCDD ${desc}</div>` : '';

    return `
        <div class="gcal-item-wrapper">
            <div class="gcal-main-row">
                ${iconHtml}
                <div class="gcal-title-block">
                    ${timeLabel}
                    <span class="gcal-title-text">${title}</span>
                </div>
            </div>
            ${locHtml}
            ${descHtml}
        </div>
    `;
}

// ==========================================================================
// 3. カレンダー描画・予定リスト描画・基本操作
// ==========================================================================

function draw() {
    const y = cur.getFullYear(), m = cur.getMonth();
    document.getElementById('calendar-title').innerText = `${y}年 ${m + 1}月`;
    const first = new Date(y, m, 1).getDay(), last = new Date(y, m + 1, 0).getDate();
    const container = document.getElementById('calendar-days');
    container.innerHTML = '';

    for (let i = 0; i < first; i++) container.innerHTML += '<div class="empty-cell"></div>';

    const today = new Date();
    const todayKey = dateKey(today.getFullYear(), today.getMonth() + 1, today.getDate());

    for (let d = 1; d <= last; d++) {
        const k = dateKey(y, m + 1, d), w = new Date(y, m, d).getDay(), h = holidays[k];

        let c = 'day-normal';
        if (w === 0 || h) c = 'day-sun-holiday';
        else if (w === 6) c = 'day-sat';
        if (k === todayKey) c += ' day-today';

        const daySchedules = schedules[k] || new Array();
        const plansHtml = daySchedules
            .map((p) => `<div class="plan-item">${formatGoogleStylePlan(p, false)}</div>`)
            .join('');
        const hHtml = h ? `<span class="holiday-name">${h}</span>` : '';

        const rokuyo = getRokuyo(y, m + 1, d);
        const rokuyoClass = rokuyo === "大安" ? "rokuyo-taian" : rokuyo === "仏滅" ? "rokuyo-butsumetsu" : "rokuyo-normal";
        const rokuyoHtml = `<span class="rokuyo ${rokuyoClass}">${rokuyo}</span>`;

        container.innerHTML += `
            <div class="day-cell ${c} ${selected === k ? 'selected' : ''}" onclick="selectDate('${k}')">
                <div class="cell-top-wrapper">
                    <div class="cell-top">
                        <span class="day-num" style="font-weight:bold; color:${w === 0 || h ? 'red' : w === 6 ? 'blue' : ''};">${d}</span>
                        ${rokuyoHtml}
                    </div>
                    <div class="meta-info">
                        ${hHtml}
                        ${tempHtml(k)}
                    </div>
                </div>
                <div class="plan-container">
                    ${plansHtml}
                </div>
            </div>`;
    }
    document.getElementById('side-title').innerText = `${selected} の予定`;
    renderList();
}

function render(refresh = true) {
    draw();
    if (refresh) refreshMeta();
}

function changeMonth(v) {
    temps = {};
    cur.setMonth(cur.getMonth() + v);
    render(true);
}

function selectDate(k) {
    selected = k;
    render(false);

    if (window.innerWidth <= 768) {
        const container = document.querySelector('.container');
        const sideBox = document.querySelector('.side-box');
        if (container && sideBox) {
            if (!document.getElementById('mobile-back-btn')) {
                const backBtn = document.createElement('button');
                backBtn.id = 'mobile-back-btn';
                backBtn.className = 'mobile-back-btn';
                backBtn.innerText = '◀ カレンダーに戻る';
                backBtn.onclick = closeMobileDayView;
                sideBox.insertBefore(backBtn, sideBox.firstChild);
            }
            container.classList.add('mobile-detail-mode');
            window.scrollTo(0, 0);
        }
    }
}

function closeMobileDayView() {
    const container = document.querySelector('.container');
    if (container) container.classList.remove('mobile-detail-mode');
}

function goToday() {
    temps = {};
    cur = new Date();
    selected = dateKey(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
    render(true);
}

function renderList() {
    const list = schedules[selected] || new Array();
    document.getElementById('plan-list').innerHTML = list.length === 0
        ? "<p class='empty-plan-msg'>予定はありません</p>"
        : list.map((p, i) => `
            <div class="list-item gcal-list-card" style="cursor:pointer;">
                <div onclick="openEditModal(${i})" style="flex:1; min-width:0;">
                    ${formatGoogleStylePlan(p, true)}
                </div>
                <button type="button" class="del-plan-btn" onclick="delPlan(${i}); event.stopPropagation();" title="削除">×</button>
            </div>
          `).join('');
}

function delPlan(i) {
    const list = schedules[selected] || new Array();
    const targetPlan = list.at(i);
    if (!targetPlan) return;

    const cleanTitle = targetPlan
        .replace(/^\[icon:.*?\]\s*/, '')
        .replace(/^\[終日\]\s*/, '')
        .replace(/^\[\d{1,2}:\d{2}～\d{0,2}:?\d{0,2}\]\s*/, '');

    if (!confirm(`「${cleanTitle}」を削除してもよろしいですか？`)) {
        return;
    }

    schedules[selected].splice(i, 1);
    if (schedules[selected].length === 0) delete schedules[selected];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
    render(false);
}

// ==========================================================================
// 4. 年月ピッカー・全画面設定モーダル（PC・スマホ共通）
// ==========================================================================

function toggleYearMonthPicker() {
    const picker = document.getElementById('ym-picker');
    if (picker.style.display === 'none') {
        pickerYear = cur.getFullYear();
        document.getElementById('picker-year-title').innerText = `${pickerYear}年`;
        picker.style.display = 'block';
    } else {
        picker.style.display = 'none';
    }
}

function changePickerYear(v) {
    pickerYear += v;
    document.getElementById('picker-year-title').innerText = `${pickerYear}年`;
}

function selectPickerMonth(m) {
    temps = {};
    cur.setFullYear(pickerYear);
    cur.setMonth(m - 1);
    selected = dateKey(pickerYear, m, 1);
    toggleYearMonthPicker();
    render(true);
}

function toggleSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    modal.style.display = modal.style.display === 'none' ? 'flex' : 'none';
}

// ==========================================================================
// 5. スタンプ（アイコン）別画面選択UI ＆ 予定追加・編集モーダル
// ==========================================================================

function updateStampTriggerButton() {
    const btn = document.getElementById('stampTriggerBtn');
    if (!btn) return;
    const src = resolveStampSrc(selectedIconFile);
    if (src) {
        btn.innerHTML = `<img src="${src}" alt="スタンプ">`;
        btn.classList.add('has-icon');
    } else {
        btn.innerHTML = 'スタンプ';
        btn.classList.remove('has-icon');
    }
}

function getIconsPerPage() {
    // PC・スマホともに1画面40個表示（「なし」ボタン含む）
    return 40;
}

function openIconPickerView() {
    tempSelectedIconFile = selectedIconFile;
    iconCurrentPage = 1;

    document.getElementById('scheduleFormView').style.display = 'none';
    document.getElementById('iconPickerView').style.display = 'block';
    renderIconPickerPage();
}

function renderIconPickerPage() {
    const grid = document.getElementById('iconPickerGrid');
    const pagination = document.getElementById('iconPagination');
    const indicator = document.getElementById('iconPageIndicator');
    if (!grid) return;

    const folderIcons = getFolderIcons();
    const allItems = new Array({ type: 'none', id: '', src: '' });
    folderIcons.forEach(fileName => {
        allItems.push({ type: 'icon', id: fileName, src: resolveStampSrc(fileName) });
    });

    const perPage = getIconsPerPage();
    const totalPages = Math.max(1, Math.ceil(allItems.length / perPage));
    if (iconCurrentPage > totalPages) iconCurrentPage = totalPages;
    if (iconCurrentPage < 1) iconCurrentPage = 1;

    const startIdx = (iconCurrentPage - 1) * perPage;
    const pageItems = allItems.slice(startIdx, startIdx + perPage);

    grid.innerHTML = pageItems.map(item => {
        const isSel = tempSelectedIconFile === item.id ? 'selected' : '';
        if (item.type === 'none') {
            return `
                <button type="button" class="icon-choice-btn icon-none-btn ${isSel}" onclick="selectTempIcon('')">
                    なし
                </button>
            `;
        }
        const safeId = item.id.replace(/'/g, "\\'");
        return `
            <button type="button" class="icon-choice-btn ${isSel}" onclick="selectTempIcon('${safeId}')">
                <img src="${item.src}" alt="スタンプ">
            </button>
        `;
    }).join('');

    if (totalPages > 1) {
        pagination.style.display = 'flex';
        indicator.innerText = `(${iconCurrentPage}/${totalPages})`;
    } else {
        pagination.style.display = 'none';
    }
}

function selectTempIcon(iconId) {
    tempSelectedIconFile = iconId;
    renderIconPickerPage();
}

function changeIconPage(delta) {
    const totalItems = getFolderIcons().length + 1;
    const totalPages = Math.max(1, Math.ceil(totalItems / getIconsPerPage()));
    iconCurrentPage += delta;
    if (iconCurrentPage < 1) iconCurrentPage = totalPages;
    if (iconCurrentPage > totalPages) iconCurrentPage = 1;
    renderIconPickerPage();
}

function confirmIconSelection() {
    selectedIconFile = tempSelectedIconFile;
    updateStampTriggerButton();
    document.getElementById('iconPickerView').style.display = 'none';
    document.getElementById('scheduleFormView').style.display = 'block';
}

function cancelIconSelection() {
    document.getElementById('iconPickerView').style.display = 'none';
    document.getElementById('scheduleFormView').style.display = 'block';
}

function getNearestHourDefaults() {
    const now = new Date();
    let nextHour = now.getHours() + 1;
    let endHour = nextHour + 1;

    if (nextHour >= 24) {
        nextHour = 23;
        endHour = 23;
    } else if (endHour >= 24) {
        endHour = 23;
    }

    return {
        startStr: `${pad(nextHour)}:00`,
        endStr: nextHour === 23 ? '23:59' : `${pad(endHour)}:00`
    };
}

function updateAllDayState(isAllDay) {
    const startTimeInput = document.getElementById('startTime');
    const endTimeInput = document.getElementById('endTime');
    if (!startTimeInput || !endTimeInput) return;

    if (isAllDay) {
        endTimeInput.disabled = true;
        endTimeInput.classList.add('input-disabled-gray');
    } else {
        endTimeInput.disabled = false;
        endTimeInput.classList.remove('input-disabled-gray');
    }
}

function initModalDateTimeFields(isAllDay, startTimePart = '', endTimePart = '') {
    const startTimeInput = document.getElementById('startTime');
    const endTimeInput = document.getElementById('endTime');
    if (!startTimeInput || !endTimeInput || !selected) return;

    const parts = selected.split('-').map(Number);
    const y = parts.at(0), m = parts.at(1), d = parts.at(2);
    const baseDateStr = `${y}-${pad(m)}-${pad(d)}`;
    const defaults = getNearestHourDefaults();

    if (isAllDay) {
        startTimeInput.type = 'date';
        endTimeInput.type = 'date';
        startTimeInput.value = baseDateStr;
        endTimeInput.value = baseDateStr;
    } else {
        startTimeInput.type = 'datetime-local';
        endTimeInput.type = 'datetime-local';
        startTimeInput.value = startTimePart ? `${baseDateStr}T${startTimePart}` : `${baseDateStr}T${defaults.startStr}`;
        endTimeInput.value = endTimePart ? `${baseDateStr}T${endTimePart}` : `${baseDateStr}T${defaults.endStr}`;
    }

    updateAllDayState(isAllDay);
}

function openNewScheduleModal() {
    editingPlanIndex = null;
    selectedIconFile = '';

    const overlay = document.getElementById('calendarModalOverlay');
    const scheduleForm = document.getElementById('scheduleForm');
    const allDayCheckbox = document.getElementById('allDayCheckbox');
    if (!overlay || !scheduleForm) return;

    scheduleForm.reset();
    if (allDayCheckbox) allDayCheckbox.checked = false;
    initModalDateTimeFields(false);
    updateStampTriggerButton();

    document.getElementById('iconPickerView').style.display = 'none';
    document.getElementById('scheduleFormView').style.display = 'block';

    const modalTitle = overlay.querySelector('#scheduleFormView .modal-title');
    if (modalTitle) modalTitle.innerText = "新しい予定を追加";

    overlay.style.display = 'flex';
}

function openEditModal(index) {
    const list = schedules[selected] || new Array();
    const rawText = list.at(index);
    if (!rawText) return;

    editingPlanIndex = index;

    const overlay = document.getElementById('calendarModalOverlay');
    const titleInput = document.getElementById('scheduleTitle');
    const allDayCheckbox = document.getElementById('allDayCheckbox');
    const locationInput = document.getElementById('scheduleLocation');
    const descInput = document.getElementById('scheduleDescription');
    if (!overlay) return;

    let text = rawText;

    let extractedIcon = '';
    const iconMatch = text.match(/^\[icon:(.*?)\]\s*/);
    if (iconMatch) {
        extractedIcon = iconMatch.at(1);
        text = text.replace(iconMatch.at(0), '').trim();
    }

    let isAllDay = false;
    let startTimePart = '';
    let endTimePart = '';

    if (text.startsWith('[終日]')) {
        isAllDay = true;
        text = text.replace('[終日]', '').trim();
    } else if (text.startsWith('[')) {
        const timeMatch = text.match(/^\[(.*?)～(.*?)\]/);
        if (timeMatch) {
            startTimePart = timeMatch.at(1) ? timeMatch.at(1).trim() : '';
            endTimePart = timeMatch.at(2) ? timeMatch.at(2).trim() : '';
            text = text.replace(timeMatch.at(0), '').trim();
        }
    }

    let location = '';
    if (text.includes(' @')) {
        const parts = text.split(' @');
        const locDescPart = parts.pop();
        location = locDescPart.split(' (').at(0).trim();
        text = parts.join(' @').trim();

        if (locDescPart.includes(' (')) {
            text += ' (' + locDescPart.split(' (').slice(1).join(' (');
        }
    }

    let desc = '';
    const descMatch = text.match(/\(([^)]*)\)$/);
    if (descMatch) {
        desc = descMatch.at(1).trim();
        text = text.replace(/\([^)]*\)$/, '').trim();
    }

    selectedIconFile = extractedIcon;
    updateStampTriggerButton();

    if (titleInput) titleInput.value = text;
    if (allDayCheckbox) allDayCheckbox.checked = isAllDay;
    initModalDateTimeFields(isAllDay, startTimePart, endTimePart);
    if (locationInput) locationInput.value = location;
    if (descInput) descInput.value = desc;

    document.getElementById('iconPickerView').style.display = 'none';
    document.getElementById('scheduleFormView').style.display = 'block';

    const modalTitle = overlay.querySelector('#scheduleFormView .modal-title');
    if (modalTitle) modalTitle.innerText = "予定の編集";

    overlay.style.display = 'flex';
}

function closeScheduleModal() {
    const overlay = document.getElementById('calendarModalOverlay');
    const scheduleForm = document.getElementById('scheduleForm');
    editingPlanIndex = null;
    if (overlay) overlay.style.display = 'none';
    if (scheduleForm) scheduleForm.reset();
}

function handleScheduleSubmit(e) {
    e.preventDefault();

    const title = (document.getElementById('scheduleTitle')?.value || '').trim();
    if (!title) return;

    const start = document.getElementById('startTime')?.value || '';
    const end = document.getElementById('endTime')?.value || '';
    const isAllDay = document.getElementById('allDayCheckbox')?.checked || false;
    const location = (document.getElementById('scheduleLocation')?.value || '').trim();
    const desc = (document.getElementById('scheduleDescription')?.value || '').trim();

    let targetDateKey = selected;
    if (start) {
        const datePart = start.split('T').at(0);
        if (datePart) {
            const parts = datePart.split('-').map(Number);
            const y = parts.at(0), m = parts.at(1), d = parts.at(2);
            if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
                targetDateKey = `${y}-${m}-${d}`;
            }
        }
    }

    let planText = '';
    if (selectedIconFile) {
        planText += `[icon:${selectedIconFile}] `;
    }
    if (isAllDay) {
        planText += '[終日] ';
    } else {
        const startTimePart = start.includes('T') ? start.split('T').at(1) : '';
        const endTimePart = end.includes('T') ? end.split('T').at(1) : '';
        if (startTimePart) {
            const sTime = startTimePart.substring(0, 5);
            const eTime = endTimePart ? endTimePart.substring(0, 5) : '';
            planText += `[${sTime}～${eTime}] `;
        }
    }
    planText += title;
    if (location) planText += ` @${location}`;
    if (desc) planText += ` (${desc})`;

    if (editingPlanIndex !== null) {
        if (targetDateKey === selected) {
            if (!schedules[selected]) schedules[selected] = new Array();
            schedules[selected].splice(editingPlanIndex, 1, planText);
        } else {
            if (schedules[selected] && schedules[selected].at(editingPlanIndex) !== undefined) {
                schedules[selected].splice(editingPlanIndex, 1);
                if (schedules[selected].length === 0) delete schedules[selected];
            }
            if (!schedules[targetDateKey]) schedules[targetDateKey] = new Array();
            schedules[targetDateKey].push(planText);

            selected = targetDateKey;
            const parts = targetDateKey.split('-').map(Number);
            cur.setFullYear(parts.at(0));
            cur.setMonth(parts.at(1) - 1);
        }
    } else {
        if (!schedules[targetDateKey]) schedules[targetDateKey] = new Array();
        schedules[targetDateKey].push(planText);

        selected = targetDateKey;
        const parts = targetDateKey.split('-').map(Number);
        cur.setFullYear(parts.at(0));
        cur.setMonth(parts.at(1) - 1);
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
    closeScheduleModal();
    render(true);
}

document.addEventListener('DOMContentLoaded', () => {
    const openModalBtn = document.getElementById('openModalBtn');
    const mobileFab = document.getElementById('mobile-fab');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const cancelModalBtn = document.getElementById('cancelModalBtn');
    const modalOverlay = document.getElementById('calendarModalOverlay');
    const scheduleForm = document.getElementById('scheduleForm');
    const allDayCheckbox = document.getElementById('allDayCheckbox');

    if (openModalBtn) openModalBtn.addEventListener('click', openNewScheduleModal);
    if (mobileFab) mobileFab.addEventListener('click', openNewScheduleModal);
    if (closeModalBtn) closeModalBtn.addEventListener('click', closeScheduleModal);
    if (cancelModalBtn) cancelModalBtn.addEventListener('click', closeScheduleModal);

    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closeScheduleModal();
        });
    }

    if (allDayCheckbox) {
        allDayCheckbox.addEventListener('change', (e) => {
            initModalDateTimeFields(e.target.checked);
        });
    }

    if (scheduleForm) {
        scheduleForm.addEventListener('submit', handleScheduleSubmit);
    }
});

// ==========================================================================
// 6. CSV エクスポート / インポート
// ==========================================================================

function parseCSVRows(csvText) {
    const rows = new Array();
    let currentRow = new Array();
    let currentCell = '';
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const ch = csvText.charAt(i);
        const nextCh = csvText.charAt(i + 1);

        if (inQuotes) {
            if (ch === '"' && nextCh === '"') {
                currentCell += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                currentCell += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                currentRow.push(currentCell);
                currentCell = '';
            } else if (ch === '\r' && nextCh === '\n') {
                currentRow.push(currentCell);
                rows.push(currentRow);
                currentRow = new Array();
                currentCell = '';
                i++;
            } else if (ch === '\n' || ch === '\r') {
                currentRow.push(currentCell);
                rows.push(currentRow);
                currentRow = new Array();
                currentCell = '';
            } else {
                currentCell += ch;
            }
        }
    }

    if (currentCell.length > 0 || currentRow.length > 0) {
        currentRow.push(currentCell);
        rows.push(currentRow);
    }

    return rows;
}

function exportToCSV() {
    const headers = Array.of(
        'Subject',
        'Start Date',
        'Start Time',
        'End Date',
        'End Time',
        'All Day Event',
        'Description',
        'Location'
    );
    const rows = Array.of(headers.join(','));

    const escapeCsvCell = (value) => {
        const str = String(value == null ? '' : value);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return '"' + str.split('"').join('""') + '"';
        }
        return str;
    };

    const sortedKeys = Object.keys(schedules).sort((a, b) => {
        const ap = a.split('-').map(Number);
        const bp = b.split('-').map(Number);
        return new Date(ap.at(0), ap.at(1) - 1, ap.at(2)) - new Date(bp.at(0), bp.at(1) - 1, bp.at(2));
    });

    sortedKeys.forEach(dKey => {
        const parts = dKey.split('-').map(Number);
        const y = parts.at(0), m = parts.at(1), d = parts.at(2);
        if (!y || !m || !d) return;

        const formattedDate = `${pad(m)}/${pad(d)}/${y}`;
        const dayPlans = schedules[dKey] || new Array();

        dayPlans.forEach(rawText => {
            let text = String(rawText || '');
            let iconTag = '';

            const newIconMatch = text.match(/^\[icon:(.*?)\]\s*/);
            if (newIconMatch) {
                iconTag = `[icon:${newIconMatch.at(1)}]`;
                text = text.replace(newIconMatch.at(0), '');
            } else {
                const oldIconMatch = text.match(/^([a-zA-Z0-9_-]+)\s+/);
                if (oldIconMatch) {
                    const iconName = oldIconMatch.at(1);
                    iconTag = iconName.includes('.') ? `[icon:${iconName}]` : `[icon:${iconName}.png]`;
                    text = text.replace(oldIconMatch.at(0), '');
                }
            }

            let isAllDay = 'False';
            let startTime = '';
            let endTime = '';

            if (text.startsWith('[終日] ')) {
                isAllDay = 'True';
                text = text.replace('[終日] ', '');
            } else {
                const bracketTimeMatch = text.match(/^\[(\d{1,2}:\d{2})～(\d{1,2}:\d{2})?\]\s*/);
                const plainTimeMatch = text.match(/^(\d{1,2}:\d{2})\s+/);

                if (bracketTimeMatch) {
                    startTime = bracketTimeMatch.at(1);
                    endTime = bracketTimeMatch.at(2) || bracketTimeMatch.at(1);
                    text = text.replace(bracketTimeMatch.at(0), '');
                } else if (plainTimeMatch) {
                    startTime = plainTimeMatch.at(1);
                    endTime = plainTimeMatch.at(1);
                    text = text.replace(plainTimeMatch.at(0), '');
                } else {
                    isAllDay = 'True';
                }
            }

            let description = '';
            const descMatch = text.match(/\s+\(([^()]*)\)$/);
            if (descMatch) {
                description = descMatch.at(1);
                text = text.replace(descMatch.at(0), '');
            }

            let location = '';
            const locMatch = text.match(/\s+@(.*)$/);
            if (locMatch) {
                location = locMatch.at(1);
                text = text.replace(locMatch.at(0), '');
            }

            if (iconTag) {
                description = description ? `${iconTag} ${description}` : iconTag;
            }

            const subject = text.trim();

            rows.push(Array.of(
                escapeCsvCell(subject),
                escapeCsvCell(formattedDate),
                escapeCsvCell(startTime),
                escapeCsvCell(formattedDate),
                escapeCsvCell(endTime),
                escapeCsvCell(isAllDay),
                escapeCsvCell(description),
                escapeCsvCell(location)
            ).join(','));
        });
    });

    const csvContent = '\uFEFF' + rows.join('\r\n');
    const blob = new Blob(Array.of(csvContent), { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    if (link.download !== undefined) {
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `google_calendar_${new Date().toISOString().slice(0, 10)}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
}

function handleCsvFileObject(file, inputElement) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const rawContent = String(e.target.result || '').replace(/^\uFEFF/, '');
        const rows = parseCSVRows(rawContent);
        if (rows.length === 0) {
            alert('CSVファイルの中身が空です。');
            return;
        }

        const firstRow = rows.at(0) || new Array();
        const isGoogleFormat = firstRow.some(col => {
            const c = col.trim().toLowerCase();
            return c === 'subject' || c === '予定の件名' || c === '件名';
        });
        const startIndex = isGoogleFormat ? 1 : 0;

        const normalizePlanForDupCheck = (raw) => {
            let s = String(raw || '').trim();
            s = s.replace(/^\[icon:.*?\]\s*/, '');
            s = s.replace(/^[a-zA-Z0-9_-]+\s+/, '');
            s = s.replace(/^\[(\d{1,2}:\d{2})～\1\]\s*/, '$1 ');
            s = s.replace(/^\[(\d{1,2}:\d{2})～(\d{1,2}:\d{2})\]\s*/, '$1-$2 ');
            s = s.replace(/^\[終日\]\s*/, '');
            return s.replace(/\s+/g, ' ').trim();
        };

        const addPlanIfNotDuplicate = (dKey, planText) => {
            if (!schedules[dKey]) schedules[dKey] = new Array();
            const existingList = schedules[dKey];
            const newNorm = normalizePlanForDupCheck(planText);

            const isDuplicate = existingList.some(existing => {
                if (existing === planText) return true;
                return normalizePlanForDupCheck(existing) === newNorm;
            });

            if (isDuplicate) return false;
            existingList.push(planText);
            return true;
        };

        let importedCount = 0;
        let duplicateCount = 0;
        const skippedDetails = new Array();

        for (let i = startIndex; i < rows.length; i++) {
            const cols = rows.at(i);
            if (!cols || cols.every(c => !String(c || '').trim())) continue;

            if (isGoogleFormat) {
                let subject = (cols.at(0) || '').trim();
                const startDateStr = (cols.at(1) || '').trim();
                const startTime = (cols.at(2) || '').trim();
                const endDateStr = (cols.at(3) || '').trim() || startDateStr;
                const endTime = (cols.at(4) || '').trim();
                const allDayFlag = (cols.at(5) || '').trim().toLowerCase();
                let description = (cols.at(6) || '').trim();
                const location = (cols.at(7) || '').trim();

                if (!startDateStr) {
                    skippedDetails.push(`${i + 1}行目: 開始日が空です`);
                    continue;
                }

                const parseFlexibleDate = (dStr) => {
                    const nums = dStr.split(/[^0-9]+/).filter(Boolean).map(Number);
                    if (nums.length < 3) return null;
                    let y, m, d;
                    if (nums.at(0) > 1000) {
                        y = nums.at(0); m = nums.at(1); d = nums.at(2);
                    } else {
                        m = nums.at(0); d = nums.at(1); y = nums.at(2);
                    }
                    if (!y || !m || !d) return null;
                    return new Date(y, m - 1, d);
                };

                const startDateObj = parseFlexibleDate(startDateStr);
                const endDateObj = parseFlexibleDate(endDateStr) || startDateObj;

                if (!startDateObj || isNaN(startDateObj.getTime())) {
                    skippedDetails.push(`${i + 1}行目: 日付形式が不正です (${startDateStr})`);
                    continue;
                }

                let iconPrefix = '';
                const iconMatch = description.match(/^\[icon:(.*?)\]\s*/);
                if (iconMatch) {
                    iconPrefix = `[icon:${iconMatch.at(1)}] `;
                    description = description.replace(iconMatch.at(0), '').trim();
                }

                if (!subject) {
                    subject = description || '(無題)';
                }

                let timePrefix = '';
                if (allDayFlag === 'true' || allDayFlag === '1' || allDayFlag === 'yes') {
                    timePrefix = '[終日] ';
                } else if (startTime) {
                    const sParts = startTime.split(':');
                    const sTime = sParts.length >= 2 ? `${sParts.at(0).padStart(2, '0')}:${sParts.at(1).padStart(2, '0')}` : startTime;
                    let eTime = sTime;
                    if (endTime) {
                        const eParts = endTime.split(':');
                        eTime = eParts.length >= 2 ? `${eParts.at(0).padStart(2, '0')}:${eParts.at(1).padStart(2, '0')}` : endTime;
                    }
                    timePrefix = `[${sTime}～${eTime}] `;
                }

                let planText = `${iconPrefix}${timePrefix}${subject}`;
                if (location) planText += ` @${location}`;
                if (description && subject !== description) planText += ` (${description})`;

                const cursor = new Date(startDateObj.getTime());
                const limitDate = endDateObj >= startDateObj ? endDateObj : startDateObj;
                let safetyCounter = 0;

                while (cursor <= limitDate && safetyCounter < 366) {
                    const dKey = `${cursor.getFullYear()}-${cursor.getMonth() + 1}-${cursor.getDate()}`;
                    if (addPlanIfNotDuplicate(dKey, planText)) {
                        importedCount++;
                    } else {
                        duplicateCount++;
                    }
                    cursor.setDate(cursor.getDate() + 1);
                    safetyCounter++;
                }
            } else {
                const y = parseInt(String(cols.at(0) || '').replace(/\D/g, ''), 10);
                const m = parseInt(String(cols.at(1) || '').replace(/\D/g, ''), 10);
                const d = parseInt(String(cols.at(2) || '').replace(/\D/g, ''), 10);
                const content = (cols.at(3) || '').trim();
                if (!y || !m || !d || !content) {
                    skippedDetails.push(`${i + 1}行目: 旧形式のデータが不足しています`);
                    continue;
                }

                const dKey = `${y}-${m}-${d}`;
                if (addPlanIfNotDuplicate(dKey, content)) {
                    importedCount++;
                } else {
                    duplicateCount++;
                }
            }
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
        render(true);

        let msg = `${importedCount}件の予定をインポートしました。`;
        if (duplicateCount > 0) {
            msg += `\n（重複スキップ: ${duplicateCount}件）`;
        }
        if (skippedDetails.length > 0) {
            msg += `\n\n【エラー等でスキップされた行 (${skippedDetails.length}件)】\n` + skippedDetails.slice(0, 10).join('\n');
        }
        alert(msg);
        if (inputElement) inputElement.value = '';
    };

    reader.readAsText(file, 'UTF-8');
}

function importFromCSV(arg) {
    const input = (arg && arg.target) ? arg.target : arg;
    const file = input && input.files ? input.files.item(0) : null;
    handleCsvFileObject(file, input);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') render(true);
});

render(true);
