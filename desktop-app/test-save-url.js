// Test script to save a URL for a profile
// Usage: node test-save-url.js <profileId> <url>

const http = require('http');

const profileId = process.argv[2];
const url = process.argv[3] || 'https://twitter.com';

if (!profileId) {
  console.log('Usage: node test-save-url.js <profileId> <url>');
  console.log('Example: node test-save-url.js 1234567890 https://twitter.com');
  process.exit(1);
}

const data = JSON.stringify({
  profileId: profileId,
  url: url
});

const options = {
  hostname: 'localhost',
  port: 45678,
  path: '/api/save-url',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  
  res.on('data', (d) => {
    process.stdout.write(d);
    console.log('\nURL saved successfully!');
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
  console.log('Make sure the desktop app is running!');
});

req.write(data);
req.end();