import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log(msg.text()));
  
  await page.goto('http://localhost:5173');
  // wait for load
  await page.waitForTimeout(2000);
  
  // enable sound
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('nocturne_settings') || '{}');
    s.typewriterSound = true;
    s.typewriterMode = true;
    localStorage.setItem('nocturne_settings', JSON.stringify(s));
  });
  await page.reload();
  await page.waitForTimeout(2000);
  
  // click project card
  await page.click('.project-card');
  await page.waitForTimeout(1000);
  
  // click editor
  await page.click('.page-content-prosemirror');
  await page.waitForTimeout(500);
  
  // type text
  await page.keyboard.type('test typing sound', { delay: 100 });
  await page.waitForTimeout(500);
  
  await browser.close();
})();
