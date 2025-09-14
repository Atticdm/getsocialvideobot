const { execa } = require('execa');

async function testYtDlp() {
  const testUrl = process.argv[2];
  
  if (!testUrl) {
    console.log('Usage: node test-ytdlp.js <facebook_url>');
    process.exit(1);
  }
  
  console.log('Testing yt-dlp with URL:', testUrl);
  
  try {
    const result = await execa('yt-dlp', [
      '--no-playlist',
      '-f', 'mp4/best',
      '--print', 'title',
      '--print', 'id',
      '--print', 'duration',
      testUrl
    ], { timeout: 30000 });
    
    console.log('Success!');
    console.log('Exit code:', result.exitCode);
    console.log('Stdout:', result.stdout);
    console.log('Stderr:', result.stderr);
    
  } catch (error) {
    console.log('Error occurred:');
    console.log('Exit code:', error.exitCode);
    console.log('Stdout:', error.stdout);
    console.log('Stderr:', error.stderr);
  }
}

testYtDlp();
