const https = require('https');
https.get('https://aoe-api.reliclink.com/community/leaderboard/GetPersonalStat?title=age2&profile_names=' + encodeURIComponent('["Nemesis"]'), {rejectUnauthorized: false}, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => console.log(JSON.stringify(JSON.parse(d), null, 2)));
});
