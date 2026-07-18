const zlib = require('zlib');
try {
    const data = Buffer.from('eNrtzkELgjAUB/A+y84ztqgojyGCkCDlLTo87ElDpzJXINF3zy0UIzrVoYO3///tsffjM3q4kUqVqcgxKNJyKk7E5Ywt1qv5kpJagxZlEXjtkBKNIE1klKSQdA9tU5BgH4tsi1fM+xaCTs5xU9kNx3wjJEaofAUSw73dE/UO4dTYK+bmpbZjiRo80EBcEmT+JoqZIHf6Dnb4C9UZWE0eYE3ttM/8FZd94v4tk4/MkTkyf8k8Th60LKHf', 'base64');
    const decompressed = zlib.inflateSync(data).toString();
    console.log(decompressed);
} catch (e) {
    console.error("inflateSync failed:", e.message);
    try {
        console.log("Trying raw...");
        const decompressed2 = zlib.inflateRawSync(data).toString();
        console.log(decompressed2);
    } catch(err2) {
        console.error("inflateRawSync failed:", err2.message);
    }
}
