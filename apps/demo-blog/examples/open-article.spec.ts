import { expect, test } from "@playwright/test"

test("opens an article", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("link", { name: "Read more" }).first().click()
  await expect(page.getByRole("article")).toBeVisible()
})
