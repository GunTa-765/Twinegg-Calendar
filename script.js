const STORAGE_KEY = 'y_cal';
const NAGOYA = { latitude: 35.1815, longitude: 136.9066 };

let cur = new Date();
let selected = dateKey(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
let schedules = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
let holidays = {};
let temps = {};
let metaAbort = null;

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
    const [y, m, d] = iso.split('-').map(Number);
    return dateKey(y, m, d);
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
        const [yy, mm, dd] = k.split('-').map(Number);
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
            const prev = d - 1;
            const next = d + 1;
            if (isHoliday(m, prev) && isHoliday(m, next)) add(m, d, '国民の休日');
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
    const url = `https://holidays-jp.github.io/api/v1/${y}/date.json?t=${Date.now()}`;
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

    const urls = [
        `https://api.open-meteo.com/v1/forecast?${qs}`,
        `https://archive-api.open-meteo.com/v1/archive?${qs}`
    ];

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
        const [yy, mm, dd] = iso.split('-').map(Number);
        if (!isBeforeYesterdayInclusive(yy, mm, dd, yest)) return;
        const maxT = data.daily.temperature_2m_max[i];
        const minT = data.daily.temperature_2m_min[i];
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
        const [h, t] = await Promise.all([
            fetchHolidays(y, signal).catch(() => holidays),
            fetchTemps(y, m, signal).catch(() => ({}))
        ]);
        if (signal.aborted) return;
        if (cur.getFullYear() !== y || cur.getMonth() !== m) return;
        holidays = h;
        temps = t;
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

function draw() {
    const y = cur.getFullYear(), m = cur.getMonth();
    document.getElementById('calendar-title').innerText = `${y}年 ${m + 1}月`;
    const first = new Date(y, m, 1).getDay(), last = new Date(y, m + 1, 0).getDate();
    const container = document.getElementById('calendar-days');
    container.innerHTML = '';

    for (let i = 0; i < first; i++) container.innerHTML += '<div class="empty-cell"></div>';

    for (let d = 1; d <= last; d++) {
        const k = dateKey(y, m + 1, d), w = new Date(y, m, d).getDay(), h = holidays[k];
        
        // 1. 基本の曜日・祝日クラスを決定
        let c = 'day-normal'; 
        if (w === 0 || h) c = 'day-sun-holiday'; 
        else if (w === 6) c = 'day-sat';

        // 2. 今日（当日）の判定を追加
        const today = new Date();
        const todayKey = dateKey(today.getFullYear(), today.getMonth() + 1, today.getDate());
        if (k === todayKey) {
            c += ' day-today';
        }

        // 3. 【修正：重複削除】ここでcを上書きしていた古い判定処理を綺麗に削除しました

        const plansHtml = (schedules[k] || []).map((p) => `<div class="plan-item">${p}</div>`).join('');
        const hHtml = h ? `<span class="holiday-name">${h}</span>` : '';

        // 六曜の文字と色を準備
        const rokuyo = getRokuyo(y, m + 1, d);
        const rokuyoClass = rokuyo === "大安" ? "rokuyo-taian" : rokuyo === "仏滅" ? "rokuyo-butsumetsu" : "rokuyo-normal";
        const rokuyoHtml = `<span class="rokuyo ${rokuyoClass}">${rokuyo}</span>`;

        // 日付・祝日・気温を上部にまとめ、予定は専用のコンテナ「plan-container」に入れます
        container.innerHTML += `
            <div class="day-cell ${c} ${selected === k ? 'selected' : ''}" onclick="selectDate('${k}')">
                <div class="cell-top-wrapper">
                    <div class="cell-top">
                        <span style="font-size:20px; font-weight:bold; color:${w === 0 || h ? 'red' : w === 6 ? 'blue' : ''};">${d}</span>
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
}

function goToday() {
    temps = {};
    cur = new Date();
    selected = dateKey(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
    render(true);
}

function renderList() {
    const list = schedules[selected] || [];
    document.getElementById('plan-list').innerHTML = list.length === 0
        ? "<p style='color:#999;font-size:13px;'>予定はありません</p>"
        : list.map((p, i) => `<div class="list-item"><span>${p}</span><button style="color:red;border:none;background:none;cursor:pointer;font-weight:bold;" onclick="delPlan(${i})">×</button></div>`).join('');
}

function addPlan() {
    const input = document.getElementById('plan-input'), t = input.value.trim();
    if (!t) return;
    if (!schedules[selected]) schedules[selected] = [];
    schedules[selected].push(t);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
    input.value = '';
    render(false);
}

function delPlan(i) {
    schedules[selected].splice(i, 1);
    if (schedules[selected].length === 0) delete schedules[selected];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
    render(false);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') render(true);
});

render(true);

/**
 * 六曜自動計算関数（一番下に貼り付けてください）
 */
function getRokuyo(year, month, day) {
    const rokuyoList = ["大安", "赤口", "先勝", "友引", "先負", "仏滅"];
    const list2026 = "0,2,2,3,5,0,1,3,4,5,1,2";
    const list2027 = "3,5,5,0,1,3,4,5,0,1,3,4";
    
    let csv = list2026;
    if (year === 2027) csv = list2027;
    
    const offsets = csv.split(",");
    const yearOffset = Number(offsets[month - 1] || 0);
    const index = (day + yearOffset) % 6;
    
    return rokuyoList[index];
}

// --- script.js の一番下にそのまま追記してください ---

let pickerYear = cur.getFullYear(); // 選択画面内で管理する「年」

/**
 * 年月選択画面の表示・非表示を切り替える
 */
function toggleYearMonthPicker() {
    const picker = document.getElementById('ym-picker');
    if (picker.style.display === 'none') {
        pickerYear = cur.getFullYear(); // 現在カレンダーが表示している年に合わせる
        document.getElementById('picker-year-title').innerText = `${pickerYear}年`;
        picker.style.display = 'block';
    } else {
        picker.style.display = 'none';
    }
}

/**
 * 選択画面の中の「年」を切り替える（◀ ▶ ボタン用）
 */
function changePickerYear(v) {
    pickerYear += v;
    document.getElementById('picker-year-title').innerText = `${pickerYear}年`;
}

/**
 * 月がクリックされたらカレンダーをその年月にジャンプさせる
 */
function selectPickerMonth(m) {
    temps = {}; // 気温データをリセット
    cur.setFullYear(pickerYear);
    cur.setMonth(m - 1);
    
    // 選択日もその年月の1日に合わせておくと親切です
    selected = dateKey(pickerYear, m, 1);
    
    toggleYearMonthPicker(); // 閉じる
    render(true);            // カレンダーを再描画
}

/**
 * 登録されているすべての予定をCSVファイルとしてエクスポートする
 */
function exportToCSV() {
    const headers = new Array(
        'Subject',
        'Start Date',
        'Start Time',
        'End Date',
        'End Time',
        'All Day Event',
        'Description',
        'Location'
    );
    const rows = new Array(headers.join(','));

    const escapeCsvCell = (value) => {
        const str = String(value == null ? '' : value);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return '"' + str.split('"').join('""') + '"';
        }
        return str;
    };

    // 日付順にソート
    const sortedKeys = Object.keys(schedules).sort((a, b) => {
        const aParts = a.split('-').map(Number);
        const bParts = b.split('-').map(Number);
        return new Date(aParts.at(0), aParts.at(1) - 1, aParts.at(2)) - new Date(bParts.at(0), bParts.at(1) - 1, bParts.at(2));
    });

    sortedKeys.forEach(dateKey => {
        const dParts = dateKey.split('-').map(Number);
        const y = dParts.at(0);
        const m = dParts.at(1);
        const d = dParts.at(2);
        if (!y || !m || !d) return;

        // Googleカレンダー標準の日付形式（MM/DD/YYYY）
        const formattedDate = `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
        const dayPlans = schedules[dateKey] || new Array();

        dayPlans.forEach(rawText => {
            let text = String(rawText || '');
            let iconTag = '';

            // 1. 新形式のアイコンタグ [icon:xxx.png] を抽出して保持
            const newIconMatch = text.match(/^\[icon:(.*?)\]\s*/);
            if (newIconMatch) {
                iconTag = `[icon:${newIconMatch.at(1)}]`;
                text = text.replace(newIconMatch.at(0), '');
            } else {
                // 2. 旧形式の先頭アイコン名（半角英数字 + スペース）を抽出して保持
                const oldIconMatch = text.match(/^([a-zA-Z0-9_-]+)\s+/);
                if (oldIconMatch) {
                    const iconName = oldIconMatch.at(1);
                    iconTag = iconName.includes('.') ? `[icon:${iconName}]` : `[icon:${iconName}.png]`;
                    text = text.replace(oldIconMatch.at(0), '');
                }
            }

            // 3. 終日・開始時刻・終了時刻の解析
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

            // 4. 説明 (メモ) と 場所 (@場所) の抽出
            let description = '';
            const descMatch = text.match(/\s+\(([^()]*)\)$/);
            if (descMatch) {
                description = descMatch.at(1);
                text = text.replace(descMatch.at(0), '');
            }

            let location = '';
            const locMatch = text.match(/\s+@(.*)$/);
            if (locMatch) {
                location = locMatch;
                text = text.replace(locMatch.at(0), '');
            }

            // アイコンタグを Description（説明列）の先頭に結合
            if (iconTag) {
                description = description ? `${iconTag} ${description}` : iconTag;
            }

            const subject = text.trim();

            const rowCells = new Array(
                escapeCsvCell(subject),
                escapeCsvCell(formattedDate),
                escapeCsvCell(startTime),
                escapeCsvCell(formattedDate),
                escapeCsvCell(endTime),
                escapeCsvCell(isAllDay),
                escapeCsvCell(description),
                escapeCsvCell(location)
            );
            rows.push(rowCells.join(','));
        });
    });

    const csvContent = '\uFEFF' + rows.join('\r\n');
    const blob = new Blob(new Array(csvContent), { type: 'text/csv;charset=utf-8;' });
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

/**
 * ダブルクォーテーションやセル内改行を正しく扱うCSVパーサー
 */
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

/**
 * スマホ用：予定追加画面（モーダル）を開く
 */
function openMobileAddModal() {
    document.getElementById('mobile-plan-input').value = '';
    document.getElementById('mobile-add-modal').style.display = 'flex';
    document.getElementById('mobile-plan-input').focus();
}

/**
 * スマホ用：予定追加画面（モーダル）を閉じる
 */
function closeMobileAddModal() {
    document.getElementById('mobile-add-modal').style.display = 'none';
}

/**
 * スマホ用：設定画面（モーダル）の表示切り替え
 */
function toggleMobileSettings() {
    const modal = document.getElementById('mobile-settings-modal');
    if (modal.style.display === 'none') {
        modal.style.display = 'flex';
    } else {
        modal.style.display = 'none';
    }
}

/**
 * スマホ用：モーダルから予定を追加する処理
 */
function addPlanMobile() {
    const input = document.getElementById('mobile-plan-input');
    const t = input.value.trim();
    if (!t) return;
    
    // 既存のグローバル変数「schedules」と「selected」を使って保存
    if (!schedules[selected]) schedules[selected] = [];
    schedules[selected].push(t);
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
    input.value = '';
    
    closeMobileAddModal(); // モーダルを閉じる
    render(false);         // カレンダーと下部予定リストをリフレッシュ
}
// ==========================================================================
// 5. Yahooカレンダー風 予定編集モーダル 制御スクリプト
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
    const openModalBtn = document.getElementById('openModalBtn');
    const mobileFab = document.getElementById('mobile-fab'); // 既存のスマホ用FABがあれば紐付け
    const closeModalBtn = document.getElementById('closeModalBtn');
    const cancelModalBtn = document.getElementById('cancelModalBtn');
    const modalOverlay = document.getElementById('calendarModalOverlay');
    const scheduleForm = document.getElementById('scheduleForm');
    const allDayCheckbox = document.getElementById('allDayCheckbox');
    const startTimeInput = document.getElementById('startTime');
    const endTimeInput = document.getElementById('endTime');

    // 終日チェックボックスの切り替え制御
    allDayCheckbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            startTimeInput.type = 'date';
            endTimeInput.type = 'date';
            // 現在選択されている日付をマッピング
            if (selected) {
                startTimeInput.value = selected;
                endTimeInput.value = selected;
            }
        } else {
            startTimeInput.type = 'datetime-local';
            endTimeInput.type = 'datetime-local';
            initDateTimeFields();
        }
    });

    // モーダルを開くときの時間初期化処理
    function initDateTimeFields() {
        if (!selected) return;
        
        // グローバル変数 "selected" (YYYY-M-D) から分解
        const [y, m, d] = selected.split('-').map(Number);
        const padStr = (num) => String(num).padStart(2, '0');
        
        if (allDayCheckbox.checked) {
            const dateStr = `${y}-${padStr(m)}-${padStr(d)}`;
            startTimeInput.value = dateStr;
            endTimeInput.value = dateStr;
        } else {
            // デフォルトは選択日の 10:00 〜 11:00 に設定
            const baseStr = `${y}-${padStr(m)}-${padStr(d)}`;
            startTimeInput.value = `${baseStr}T10:00`;
            endTimeInput.value = `${baseStr}T11:00`;
        }
    }

    // モーダルを開く関数
    const openModal = () => {
        allDayCheckbox.checked = false;
        startTimeInput.type = 'datetime-local';
        endTimeInput.type = 'datetime-local';
        initDateTimeFields();
        modalOverlay.style.display = 'flex';
    };

    // モーダルを閉じる関数
    const closeModal = () => {
        modalOverlay.style.display = 'none';
        scheduleForm.reset();
    };

    // イベントリスナーの登録
    if (openModalBtn) openModalBtn.addEventListener('click', openModal);
    if (mobileFab) mobileFab.addEventListener('click', openModal); // スマホ用FABでも同じモーダルを開く
    
    if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
    if (cancelModalBtn) cancelModalBtn.addEventListener('click', closeModal);
    
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });

    // フォーム送信（保存）時のアクション
    scheduleForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const title = document.getElementById('scheduleTitle').value.trim();
        const start = startTimeInput.value;
        const end = endTimeInput.value;
        const isAllDay = allDayCheckbox.checked;
        const location = document.getElementById('scheduleLocation').value.trim();
        const desc = document.getElementById('scheduleDescription').value.trim();

        if (!title) return;

        // Yahooカレンダー風に、入力された項目を1つの見やすい文字列に整形
        let planText = "";
        
        if (isAllDay) {
            planText += "[終日] ";
        } else {
            const startTimePart = start.split('T')[1] || "";
            const endTimePart = end.split('T')[1] || "";
            if (startTimePart) planText += `[${startTimePart}～${endTimePart}] `;
        }

        planText += title;
        if (location) planText += ` @${location}`;
        if (desc) planText += ` (${desc})`;

        // 既存のグローバルオブジェクト schedules[selected] へのデータ挿入ロジックを流用
        if (!schedules[selected]) schedules[selected] = [];
        schedules[selected].push(planText);

        // ローカルストレージに保存 (既存の STORAGE_KEY を使用)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));

        // カレンダー画面の再描画関数を呼び出し
        if (typeof render === 'function') {
            render(false);
        }

        closeModal();
    });
});

// 既存のスマホ用追加関数をオーバーライド（バグ防止・共通化）
function openMobileAddModal() {
    const overlay = document.getElementById('calendarModalOverlay');
    if (overlay) {
        // PC/スマホ共通でリッチな編集モーダルを開くように変更します
        document.getElementById('openModalBtn').click();
    }
}
function renderList() {
    const list = schedules[selected] || [];
    document.getElementById('plan-list').innerHTML = list.length === 0
        ? "<p style='color:#999;font-size:13px;'>予定はありません</p>"
        : list.map((p, i) => `
            <div class="list-item" style="cursor:pointer;">
                <span onclick="openEditModal(${i})" style="flex:1; display:block;">${p}</span>
                <button style="color:red;border:none;background:none;cursor:pointer;font-weight:bold;padding:0 5px;" onclick="delPlan(${i}); event.stopPropagation();">×</button>
            </div>
          `).join('');
}
// --- script.js の一番下にそのまま追記してください ---
// ==========================================================================
// スマホ・PC共通 確定版：予定編集・日時移動スクリプト
// ==========================================================================

let editingPlanIndex = null; // 現在編集中の予定の番号（nullの場合は新規追加）

/**
 * 登録済みの予定をクリックしたときに、編集モードでモーダルを開く
 */
function openEditModal(index) {
    const list = schedules[selected] || [];
    const rawText = list[index];
    if (!rawText) return;

    editingPlanIndex = index; // 編集中のインデックスを保存

    // モーダル要素の取得
    const overlay = document.getElementById('calendarModalOverlay');
    const titleInput = document.getElementById('scheduleTitle');
    const allDayCheckbox = document.getElementById('allDayCheckbox');
    const startTimeInput = document.getElementById('startTime');
    const endTimeInput = document.getElementById('endTime');
    const locationInput = document.getElementById('scheduleLocation');
    const descInput = document.getElementById('scheduleDescription');

    if (!overlay) return;

    // --- Yahooカレンダー風の成形文字列から各データをパース（分解）する ---
    let text = rawText;
    
    // 1. [終日] または [時間] の切り出し
    let isAllDay = false;
    let startTimePart = "";
    let endTimePart = "";

    if (text.startsWith("[終日]")) {
        isAllDay = true;
        text = text.replace("[終日]", "").trim();
    } else if (text.startsWith("[")) {
        const timeMatch = text.match(/^\[(.*?)～(.*?)\]/);
        if (timeMatch) {
            startTimePart = timeMatch[1] ? timeMatch[1].trim() : "";
            endTimePart = timeMatch[2] ? timeMatch[2].trim() : "";
            text = text.replace(timeMatch[0], "").trim();
        }
    }

    // 2. 場所（ @場所 ）の切り出し
    let location = "";
    if (text.includes(" @")) {
        const parts = text.split(" @");
        const locDescPart = parts.pop(); 
        location = locDescPart.split(" (")[0].trim();
        text = parts.join(" @").trim();
        
        if (locDescPart.includes(" (")) {
            text += " (" + locDescPart.split(" (").slice(1).join(" (");
        }
    }

    // 3. 説明（ (説明文) ）の切り出し
    let desc = "";
    const descMatch = text.match(/\(([^)]*)\)$/);
    if (descMatch) {
        desc = descMatch[1].trim();
        text = text.replace(/\([^)]*\)$/, "").trim();
    }

    // タイトルは残ったテキスト
    let title = text;

    // --- モーダルの各入力欄に値をセット ---
    if (titleInput) titleInput.value = title;
    if (allDayCheckbox) allDayCheckbox.checked = isAllDay;
    
    const [y, m, d] = selected.split('-').map(Number);
    const padStr = (num) => String(num).padStart(2, '0');
    const baseDateStr = `${y}-${padStr(m)}-${padStr(d)}`;

    if (startTimeInput && endTimeInput) {
        if (isAllDay) {
            startTimeInput.type = 'date';
            endTimeInput.type = 'date';
            startTimeInput.value = baseDateStr;
            endTimeInput.value = baseDateStr;
        } else {
            startTimeInput.type = 'datetime-local';
            endTimeInput.type = 'datetime-local';
            startTimeInput.value = startTimePart ? `${baseDateStr}T${startTimePart}` : `${baseDateStr}T10:00`;
            endTimeInput.value = endTimePart ? `${baseDateStr}T${endTimePart}` : `${baseDateStr}T11:00`;
        }
    }

    if (locationInput) locationInput.value = location;
    if (descInput) descInput.value = desc;

    // モーダルのタイトルを「予定の編集」に変更
    const modalTitle = overlay.querySelector('.modal-title');
    if (modalTitle) modalTitle.innerText = "予定の編集";

    // モーダルを表示
    overlay.style.display = 'flex';
}

/**
 * 登録ボタン（新規追加）を押したときは編集モードをリセットする
 */
document.addEventListener('DOMContentLoaded', () => {
    const openModalBtn = document.getElementById('openModalBtn');
    const mobileFab = document.getElementById('mobile-fab');
    const scheduleForm = document.getElementById('scheduleForm');

    const resetToNew = () => {
        editingPlanIndex = null; // 新規追加モードにする
        const overlay = document.getElementById('calendarModalOverlay');
        if (overlay) {
            const modalTitle = overlay.querySelector('.modal-title');
            if (modalTitle) modalTitle.innerText = "新しい予定を追加";
        }
    };

    if (openModalBtn) openModalBtn.addEventListener('click', resetToNew);
    if (mobileFab) mobileFab.addEventListener('click', resetToNew);

    // フォーム送信（保存ボタン）ロジックの完全確定版
    if (scheduleForm) {
        // 既存のイベントリスナーによる競合を防ぐため、一度cloneしてイベントをクリアするか、最優先で実行させます
        scheduleForm.addEventListener('submit', (e) => {
            e.preventDefault();
            e.stopPropagation(); // スマホの重複イベントをカット
            
            const titleInput = document.getElementById('scheduleTitle');
            const startTimeInput = document.getElementById('startTime');
            const endTimeInput = document.getElementById('endTime');
            const allDayCheckbox = document.getElementById('allDayCheckbox');
            const locationInput = document.getElementById('scheduleLocation');
            const descInput = document.getElementById('scheduleDescription');

            const title = titleInput ? titleInput.value.trim() : "";
            if (!title) return;

            const start = startTimeInput ? startTimeInput.value : "";
            const end = endTimeInput ? endTimeInput.value : "";
            const isAllDay = allDayCheckbox ? allDayCheckbox.checked : false;
            const location = locationInput ? locationInput.value.trim() : "";
            const desc = descInput ? descInput.value.trim() : "";

            // 1. 入力された日時から「保存先の日付（YYYY-M-D形式）」を厳密に抽出
            let targetDateKey = selected; 
            if (start) {
                const datePart = start.split('T')[0]; // 必ずインデックス[0]を取得
                if (datePart) {
                    const parts = datePart.split('-');
                    const y = parseInt(parts[0], 10);
                    const m = parseInt(parts[1], 10);
                    const d = parseInt(parts[2], 10);
                    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
                        targetDateKey = `${y}-${m}-${d}`;
                    }
                }
            }

            // 2. Yahooカレンダー風のテキスト整形
            let planText = "";
            if (isAllDay) {
                planText += "[終日] ";
            } else {
                const startTimePart = start.includes('T') ? start.split('T')[1] : "";
                const endTimePart = end.includes('T') ? end.split('T')[1] : "";
                if (startTimePart) {
                    const sTime = startTimePart.substring(0, 5);
                    const eTime = endTimePart ? endTimePart.substring(0, 5) : "";
                    planText += `[${sTime}～${eTime}] `;
                }
            }
            planText += title;
            if (location) planText += ` @${location}`;
            if (desc) planText += ` (${desc})`;

            // 3. データの保存・移動処理
            if (editingPlanIndex !== null) {
                // 【編集モード】
                if (targetDateKey === selected) {
                    // 日付が変わっていない場合は通常の上書き
                    if (!schedules[selected]) schedules[selected] = [];
                    schedules[selected][editingPlanIndex] = planText;
                } else {
                    // 日付が変更された場合：元の予定を削除し、新しい日付に移動
                    if (schedules[selected] && schedules[selected][editingPlanIndex] !== undefined) {
                        schedules[selected].splice(editingPlanIndex, 1);
                        if (schedules[selected].length === 0) {
                            delete schedules[selected];
                        }
                    }
                    // 変更先の日付に追加
                    if (!schedules[targetDateKey]) schedules[targetDateKey] = [];
                    schedules[targetDateKey].push(planText);
                    
                    // 画面の選択状態も変更先の日付に合わせる
                    selected = targetDateKey; 
                    const [targetY, targetM] = targetDateKey.split('-').map(Number);
                    cur.setFullYear(targetY);
                    cur.setMonth(targetM - 1);
                }
            } else {
                // 【新規追加モード】
                if (!schedules[targetDateKey]) schedules[targetDateKey] = [];
                schedules[targetDateKey].push(planText);
                
                selected = targetDateKey;
                const [targetY, targetM] = targetDateKey.split('-').map(Number);
                cur.setFullYear(targetY);
                cur.setMonth(targetM - 1);
            }

            // ローカルストレージに確定保存
            localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
            
            // モーダルを閉じてリセット
            const overlay = document.getElementById('calendarModalOverlay');
            if (overlay) overlay.style.display = 'none';
            if (scheduleForm) scheduleForm.reset();
            
            // カレンダーリフレッシュ
            if (typeof render === 'function') {
                render(true);
            }
        }, { capture: true });
    }
});

// 旧スマホ用関数のオーバーライド（干渉・バグを完全に停止させる）
function openMobileAddModal() {
    editingPlanIndex = null;
    const overlay = document.getElementById('calendarModalOverlay');
    if (overlay) {
        const modalTitle = overlay.querySelector('.modal-title');
        if (modalTitle) modalTitle.innerText = "新しい予定を追加";
        overlay.style.display = 'flex';
    }
}
function addPlanMobile() {} // 完全に無効化
// ==========================================================================
// スマホ画面：日付タップ時の画面切り替え制御
// ==========================================================================

/**
 * カレンダー画面に戻る処理
 */
function closeMobileDayView() {
    const container = document.querySelector('.container');
    if (container) {
        container.classList.remove('mobile-detail-mode');
    }
}

/**
 * 既存の selectDate 関数を拡張（スマホ時は予定一覧画面へ切り替え）
 */
const originalSelectDate = selectDate;
selectDate = function(k) {
    // 元の選択処理を実行
    originalSelectDate(k);

    // スマホ画面（768px以下）の場合のみ画面を切り替える
    if (window.innerWidth <= 768) {
        const container = document.querySelector('.container');
        const sideBox = document.querySelector('.side-box');
        
        if (container && sideBox) {
            // 「カレンダーに戻る」ボタンがまだ無ければ生成して先頭に追加
            if (!document.getElementById('mobile-back-btn')) {
                const backBtn = document.createElement('button');
                backBtn.id = 'mobile-back-btn';
                backBtn.className = 'mobile-back-btn';
                backBtn.innerText = '◀ カレンダーに戻る';
                backBtn.onclick = closeMobileDayView;
                sideBox.insertBefore(backBtn, sideBox.firstChild);
            }

            // 詳細画面モードに切り替え、スクロール位置を一番上に戻す
            container.classList.add('mobile-detail-mode');
            window.scrollTo(0, 0);
        }
    }
};

// ==========================================================================
// 予定のアイコン表示 ＆ Googleカレンダー風書式への統一
// ==========================================================================

let selectedIconFile = ''; // 現在選択中のアイコンファイル名

/**
 * 予定データをパースしてアイコンとGoogleカレンダー風HTMLに整形する
 * 保存形式: [icon:xxx.png] [10:00～11:30] タイトル @場所 (説明)
 */
function formatGoogleStylePlan(rawText, isListMode = true) {
    let text = rawText || '';

    // 1. アイコン抽出
    let iconHtml = '';
    const iconMatch = text.match(/^\[icon:(.*?)\]\s*/);
    if (iconMatch) {
        const fileName = iconMatch[1];
        const sizeClass = isListMode ? 'list-plan-icon' : 'cell-plan-icon';
        iconHtml = `<img src="image/${encodeURIComponent(fileName)}" alt="" class="${sizeClass}">`;
        text = text.replace(iconMatch[0], '');
    }

    // 2. 時間・終日の抽出
    let timeLabel = '';
    if (text.startsWith('[終日] ')) {
        text = text.replace('[終日] ', '');
        timeLabel = isListMode ? `<span class="gcal-time-badge">終日</span>` : '';
    } else {
        const timeMatch = text.match(/^\[(\d{1,2}:\d{2})～(\d{1,2}:\d{2})?\]\s*/);
        if (timeMatch) {
            const start = timeMatch[1];
            const end = timeMatch[2] || '';
            text = text.replace(timeMatch[0], '');
            if (isListMode) {
                timeLabel = `<span class="gcal-time-text">${end ? `${start} - ${end}` : start}</span>`;
            } else {
                // カレンダーのマス内はGoogleカレンダー同様「開始時刻 タイトル」でシンプルに表示
                timeLabel = `<span class="gcal-cell-time">${start}</span> `;
            }
        }
    }

    // 3. 説明 (メモ) と 場所 (@場所) の抽出
    let desc = '';
    const descMatch = text.match(/\s+\(([^()]*)\)$/);
    if (descMatch) {
        desc = descMatch[1];
        text = text.replace(descMatch[0], '');
    }

    let location = '';
    const locMatch = text.match(/\s+@(.*)$/);
    if (locMatch) {
        location = locMatch[1];
        text = text.replace(locMatch[0], '');
    }

    const title = text.trim();

    // カレンダーマス内の表示
    if (!isListMode) {
        return `${iconHtml}${timeLabel}<span class="gcal-cell-title">${title}</span>`;
    }

    // 予定一覧画面の表示（Googleカレンダー風レイアウト）
    const locHtml = location ? `<div class="gcal-sub-info">������ ${location}</div>` : '';
    const descHtml = desc ? `<div class="gcal-sub-info gcal-desc">������ ${desc}</div>` : '';

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

/**
 * 予定入力画面にアイコン選択UIを描画する
 */
function setupIconSelectorUI(currentIcon = '') {
    selectedIconFile = currentIcon;
    const iconList = Array.isArray(window.CALENDAR_ICONS) ? [...window.CALENDAR_ICONS] : [];

    // 編集中の予定に使われているアイコンがリストに無ければ追加
    if (currentIcon && !iconList.includes(currentIcon)) {
        iconList.push(currentIcon);
    }

    const form = document.getElementById('scheduleForm');
    if (!form) return;

    let group = document.getElementById('icon-selector-group');
    if (!group) {
        group = document.createElement('div');
        group.id = 'icon-selector-group';
        group.className = 'form-group';
        const firstGroup = form.querySelector('.form-group');
        if (firstGroup && firstGroup.nextSibling) {
            form.insertBefore(group, firstGroup.nextSibling);
        } else {
            form.insertBefore(group, form.firstChild);
        }
    }

    const noneSelected = selectedIconFile === '' ? 'selected' : '';
    const itemsHtml = iconList.map(file => {
        const isSel = selectedIconFile === file ? 'selected' : '';
        return `
            <button type="button" class="icon-choice-btn ${isSel}" data-icon="${file}" onclick="selectScheduleIcon('${file.replace(/'/g, "\\'")}')">
                <img src="image/${encodeURIComponent(file)}" alt="${file}">
            </button>
        `;
    }).join('');

    group.innerHTML = `
        <label>アイコン</label>
        <div class="icon-picker-grid">
            <button type="button" class="icon-choice-btn icon-none-btn ${noneSelected}" data-icon="" onclick="selectScheduleIcon('')">なし</button>
            ${itemsHtml}
        </div>
    `;
}

/**
 * アイコン選択ボタンクリック時のハイライト更新
 */
function selectScheduleIcon(fileName) {
    selectedIconFile = fileName;
    document.querySelectorAll('.icon-choice-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.icon === fileName);
    });
}

// ==========================================================================
// フォーム保存処理・モーダル開閉・一覧描画への統合
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
    const openModalBtn = document.getElementById('openModalBtn');
    const mobileFab = document.getElementById('mobile-fab');
    const scheduleForm = document.getElementById('scheduleForm');

    const initNew = () => {
        editingPlanIndex = null;
        setupIconSelectorUI('');
    };

    if (openModalBtn) openModalBtn.addEventListener('click', initNew);
    if (mobileFab) mobileFab.addEventListener('click', initNew);

    if (scheduleForm) {
        scheduleForm.addEventListener('submit', (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();

            const title = (document.getElementById('scheduleTitle')?.value || '').trim();
            if (!title) return;

            const start = document.getElementById('startTime')?.value || '';
            const end = document.getElementById('endTime')?.value || '';
            const isAllDay = document.getElementById('allDayCheckbox')?.checked || false;
            const location = (document.getElementById('scheduleLocation')?.value || '').trim();
            const desc = (document.getElementById('scheduleDescription')?.value || '').trim();

            // 保存先の日付キー（YYYY-M-D）を決定
            let targetDateKey = selected;
            if (start) {
                const datePart = start.split('T')[0];
                if (datePart) {
                    const parts = datePart.split('-');
                    const y = parseInt(parts[0], 10);
                    const m = parseInt(parts[1], 10);
                    const d = parseInt(parts[2], 10);
                    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
                        targetDateKey = `${y}-${m}-${d}`;
                    }
                }
            }

            // 保存文字列の組み立て
            let planText = '';
            if (selectedIconFile) {
                planText += `[icon:${selectedIconFile}] `;
            }
            if (isAllDay) {
                planText += '[終日] ';
            } else {
                const startTimePart = start.includes('T') ? start.split('T')[1] : '';
                const endTimePart = end.includes('T') ? end.split('T')[1] : '';
                if (startTimePart) {
                    const sTime = startTimePart.substring(0, 5);
                    const eTime = endTimePart ? endTimePart.substring(0, 5) : '';
                    planText += `[${sTime}～${eTime}] `;
                }
            }
            planText += title;
            if (location) planText += ` @${location}`;
            if (desc) planText += ` (${desc})`;

            // 新規追加または編集の反映
            if (editingPlanIndex !== null) {
                if (targetDateKey === selected) {
                    if (!schedules[selected]) schedules[selected] = [];
                    schedules[selected][editingPlanIndex] = planText;
                } else {
                    if (schedules[selected] && schedules[selected][editingPlanIndex] !== undefined) {
                        schedules[selected].splice(editingPlanIndex, 1);
                        if (schedules[selected].length === 0) delete schedules[selected];
                    }
                    if (!schedules[targetDateKey]) schedules[targetDateKey] = [];
                    schedules[targetDateKey].push(planText);

                    selected = targetDateKey;
                    const [targetY, targetM] = targetDateKey.split('-').map(Number);
                    cur.setFullYear(targetY);
                    cur.setMonth(targetM - 1);
                }
            } else {
                if (!schedules[targetDateKey]) schedules[targetDateKey] = [];
                schedules[targetDateKey].push(planText);

                selected = targetDateKey;
                const [targetY, targetM] = targetDateKey.split('-').map(Number);
                cur.setFullYear(targetY);
                cur.setMonth(targetM - 1);
            }

            localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
            editingPlanIndex = null;

            const overlay = document.getElementById('calendarModalOverlay');
            if (overlay) overlay.style.display = 'none';
            scheduleForm.reset();

            if (typeof render === 'function') {
                render(true);
            }
        }, { capture: true });
    }
});

// 既存予定の編集モーダル起動
const prevOpenEditModal = openEditModal;
openEditModal = function(index) {
    const list = schedules[selected] || [];
    const rawText = list[index] || '';
    const iconMatch = rawText.match(/^\[icon:(.*?)\]\s*/);
    const extractedIcon = iconMatch ? iconMatch[1] : '';

    if (iconMatch) {
        list[index] = rawText.replace(iconMatch[0], '');
    }
    prevOpenEditModal(index);
    list[index] = rawText;

    setupIconSelectorUI(extractedIcon);
};

// スマホ用新規追加モーダル起動
const prevOpenMobileAddModal = openMobileAddModal;
openMobileAddModal = function() {
    prevOpenMobileAddModal();
    setupIconSelectorUI('');
};

// 予定一覧の描画（Googleカレンダー風レイアウト）
renderList = function() {
    const list = schedules[selected] || [];
    document.getElementById('plan-list').innerHTML = list.length === 0
        ? "<p style='color:#999;font-size:13px;'>予定はありません</p>"
        : list.map((p, i) => `
            <div class="list-item gcal-list-card" style="cursor:pointer;">
                <div onclick="openEditModal(${i})" style="flex:1; min-width:0;">
                    ${formatGoogleStylePlan(p, true)}
                </div>
                <button style="color:red;border:none;background:none;cursor:pointer;font-weight:bold;padding:0 5px;" onclick="delPlan(${i}); event.stopPropagation();">×</button>
            </div>
          `).join('');
};

// カレンダーマス内の予定表示（Googleカレンダー風：開始時刻 + タイトル）
const prevDraw = draw;
draw = function() {
    prevDraw();
    document.querySelectorAll('.plan-container .plan-item').forEach(el => {
        el.innerHTML = formatGoogleStylePlan(el.textContent, false);
    });
};

render(false);

// ==========================================================================
// CSVインポート確実実行版（HTMLの書き方を問わずファイル選択で即実行）
// ==========================================================================

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

        const addPlanIfNotDuplicate = (dateKey, planText) => {
            if (!schedules[dateKey]) {
                schedules[dateKey] = new Array();
            }
            const existingList = schedules[dateKey];
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
        let skippedDetails = new Array();

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
                        y = nums.at(0);
                        m = nums.at(1);
                        d = nums.at(2);
                    } else {
                        m = nums.at(0);
                        d = nums.at(1);
                        y = nums.at(2);
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
                    const dateKey = `${cursor.getFullYear()}-${cursor.getMonth() + 1}-${cursor.getDate()}`;
                    if (addPlanIfNotDuplicate(dateKey, planText)) {
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

                const dateKey = `${y}-${m}-${d}`;
                if (addPlanIfNotDuplicate(dateKey, content)) {
                    importedCount++;
                } else {
                    duplicateCount++;
                }
            }
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
        if (typeof render === 'function') {
            render(true);
        }

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

// HTML側の呼び出し方（event渡し / this渡し / 別名関数）をすべて吸収
function importFromCSV(arg) {
    const input = (arg && arg.target) ? arg.target : arg;
    const file = input && input.files ? input.files.item(0) : null;
    handleCsvFileObject(file, input);
}
function importCSV(arg) {
    importFromCSV(arg);
}

// 画面上のすべての <input type="file"> のファイル選択を直接検知して実行
document.addEventListener('change', function(e) {
    const target = e.target;
    if (target && target.tagName === 'INPUT' && target.type === 'file') {
        const file = target.files ? target.files.item(0) : null;
        if (file && file.name.toLowerCase().endsWith('.csv')) {
            e.stopImmediatePropagation();
            handleCsvFileObject(file, target);
        }
    }
}, true);
