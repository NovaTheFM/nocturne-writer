import { chromium } from 'playwright';

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true }); // headless because I am an AI and cannot "see" the screen. I will read logs.
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    await page.goto('http://localhost:5173');
    await page.waitForTimeout(2000);
    console.log('Page loaded. Locating project...');
    
    // Click the first project to open the editor
    const projectCard = page.locator('.project-card').first();
    await projectCard.click();
    await page.waitForTimeout(1000);
    
    console.log('Locating editor...');
    const editor = page.locator('.page-content').first();
    await editor.click();
    
    console.log('Typing text to trigger pagination...');
    for (let i = 1; i <= 60; i++) {
      await page.keyboard.type(`This is line number ${i} of our test document to test pagination.`);
      await page.keyboard.press('Enter');
    }
    
    await page.waitForTimeout(1000);
    
    const breaks = await page.locator('.pm-page-break').count();
    console.log(`Found ${breaks} page breaks.`);
    
    console.log('Moving cursor back up across the break...');
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(200);
      
      const caretInfo = await page.evaluate(() => {
        const sel = window.getSelection();
        const customCaret = document.getElementById('custom-caret');
        const rect = sel.rangeCount ? sel.getRangeAt(0)?.getClientRects()[0] : null;
        return {
          collapsed: sel.isCollapsed,
          rangeRect: rect ? { top: rect.top, left: rect.left, height: rect.height, width: rect.width } : null,
          customCaretRect: customCaret ? { top: customCaret.style.top, left: customCaret.style.left, height: customCaret.style.height, display: customCaret.style.display } : null,
          focusNode: sel.focusNode?.nodeName,
          focusText: sel.focusNode?.textContent?.substring(0, 30),
          focusOffset: sel.focusOffset
        };
      });
      console.log(`Step ${i} UP:`, caretInfo);
    }
    
  } catch (err) {
    console.error('Test error:', err);
  } finally {
    await browser.close();
  }
})();
