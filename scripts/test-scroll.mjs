import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000);
  
  // enable mode
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('nocturne_settings') || '{}');
    s.typewriterMode = true;
    localStorage.setItem('nocturne_settings', JSON.stringify(s));
  });
  await page.reload();
  await page.waitForTimeout(1000);
  
  // click project card
  await page.click('.project-card');
  await page.waitForTimeout(500);
  
  // get padding
  const paddingBottom = await page.evaluate(() => {
    const shell = document.querySelector('.page-shell');
    return shell ? shell.style.paddingBottom : null;
  });
  console.log('PaddingBottom:', paddingBottom);
  
  // get scroll value
  const scrollBefore = await page.evaluate(() => {
    return document.querySelector('.editor-scroll-area').scrollTop;
  });
  console.log('ScrollBefore:', scrollBefore);
  
  // focus and type a lot of enters
  await page.click('.page-content-prosemirror');
  for(let i=0; i<30; i++) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(20);
  }
  
  await page.waitForTimeout(500); // Wait for smooth scroll
  
  const scrollAfter = await page.evaluate(() => {
    return document.querySelector('.editor-scroll-area').scrollTop;
  });
  console.log('ScrollAfter:', scrollAfter);
  
  await browser.close();
})();
