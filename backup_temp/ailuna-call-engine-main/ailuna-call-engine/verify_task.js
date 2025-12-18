const fs = require('fs');
const path = require('path');

function check() {
  // Check system_prompt.md exists
  if (!fs.existsSync('system_prompt.md')) {
    console.error('❌ system_prompt.md missing');
    return;
  }
  console.log('✅ system_prompt.md exists');

  // Check content of system_prompt.md
  const promptContent = fs.readFileSync('system_prompt.md', 'utf-8');
  if (promptContent.includes('You are a helpful assistant.')) {
     console.log('✅ system_prompt.md content verified');
  } else {
     console.error('❌ system_prompt.md content mismatch');
  }

  // Check src/realtimeSession.ts
  const sessionCode = fs.readFileSync(path.join('src', 'realtimeSession.ts'), 'utf-8');
  if (sessionCode.includes('system_prompt.md') && sessionCode.includes('fs.readFile(mdPath, \'utf-8\')')) {
    console.log('✅ src/realtimeSession.ts updated');
  } else {
    console.error('❌ src/realtimeSession.ts not updated correctly');
  }

  // Check README.md
  const readme = fs.readFileSync('README.md', 'utf-8');
  if (readme.includes('system_prompt.md') && readme.includes('Warning')) {
    console.log('✅ README.md updated');
  } else {
    console.error('❌ README.md not updated correctly');
  }
}

check();
