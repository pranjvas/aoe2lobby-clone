const puppeteer = require('puppeteer');

async function checkUI() {
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    
    console.log("Starting QA tests...");
    
    while (true) {
        try {
            await page.goto('http://localhost:8080', { waitUntil: 'networkidle2' });
            // wait for lobbies to be loaded
            await page.waitForSelector('.lobby-card', { timeout: 10000 }).catch(() => {});
            
            const results = await page.evaluate(() => {
                const tagsRows = document.querySelectorAll('.tags-row');
                if (tagsRows.length === 0) return { status: 'no_lobbies', message: "No lobbies found or tags-row missing." };
                
                for (let i = 0; i < tagsRows.length; i++) {
                    const row = tagsRows[i];
                    const badges = Array.from(row.querySelectorAll('.badge'));
                    
                    let hasMatchType = false;
                    let hasMapSize = false;
                    let hasModInfo = false;
                    let hasPop = false;
                    let hasSpeed = false;
                    
                    let corruptedText = false;
                    let missingEmojis = false;
                    
                    badges.forEach(b => {
                        const text = b.textContent || "";
                        if (b.classList.contains('match-type-badge')) hasMatchType = true;
                        if (b.classList.contains('map-size-badge')) {
                            hasMapSize = true;
                            if (!text.includes('🗺')) missingEmojis = true;
                        }
                        if (b.classList.contains('pop-badge')) {
                            hasPop = true;
                            if (!text.includes('👥')) missingEmojis = true;
                        }
                        if (b.classList.contains('speed-badge')) {
                            hasSpeed = true;
                            if (!text.includes('⏩')) missingEmojis = true;
                        }
                        if (b.classList.contains('mod-info-badge')) {
                            hasModInfo = true;
                            if (!text.includes('⚙')) missingEmojis = true;
                        }
                        
                        if (text.includes('dY"?') || text.includes('sT,?') || text.includes('\uFFFD')) {
                            corruptedText = true;
                        }
                    });
                    
                    if (!hasMatchType || !hasMapSize || !hasModInfo || !hasPop || !hasSpeed) {
                        return {
                            status: 'error',
                            message: `Missing attributes in lobby ${i}. MatchType: ${hasMatchType}, MapSize: ${hasMapSize}, ModInfo: ${hasModInfo}, Pop: ${hasPop}, Speed: ${hasSpeed}`
                        };
                    }
                    
                    if (corruptedText || missingEmojis) {
                        return {
                            status: 'error',
                            message: `Corrupted text or missing emojis detected in lobby ${i}.`
                        };
                    }
                    
                    // Check for overlap
                    for (let j = 0; j < badges.length; j++) {
                        for (let k = j + 1; k < badges.length; k++) {
                            const rect1 = badges[j].getBoundingClientRect();
                            const rect2 = badges[k].getBoundingClientRect();
                            
                            // To be considered overlapping, they must actually intersect.
                            // We allow edges to touch.
                            const overlap = !(rect1.right <= rect2.left || 
                                              rect1.left >= rect2.right || 
                                              rect1.bottom <= rect2.top || 
                                              rect1.top >= rect2.bottom);
                                              
                            if (overlap) {
                                return { 
                                    status: 'error', 
                                    message: `Overlap detected between badges in lobby ${i}. Rect1: ${JSON.stringify(rect1)}, Rect2: ${JSON.stringify(rect2)}` 
                                };
                            }
                        }
                    }
                }
                return { status: 'ok', message: "All tags rendered without overlap." };
            });
            
            if (results.status === 'error') {
                console.error("UI_BROKEN:", results.message);
                // Exit when broken so the agent is notified immediately and doesn't spam
                process.exit(1);
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000)); // check every 5 seconds
        } catch (e) {
            console.error("QA_TEST_ERROR:", e.message);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

checkUI();
