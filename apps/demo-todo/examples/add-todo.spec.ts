import { expect, test } from "@playwright/test"

test("adds a todo", async ({ page }) => {
  await page.goto("/")
  await page.getByPlaceholder("What needs to be done?").fill("Buy milk")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Buy milk")).toBeVisible()
  await expect(page.getByText("1 left")).toBeVisible()
})
