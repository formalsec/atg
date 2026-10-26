Write an end-to-end test suite for a web app with {{framework}}. The suite should cover the features a user of the app can see and use.

What you have about the app:
[url] - The app is running at {{url}}. Explore it there, and run your tests against it.
[task] - The app's user stories are in `{{task_file}}`.
[examples] - Example tests are in `examples/`. Follow their style.
[code] - The app's source code is in `code/`.
[none] - Nothing beyond this prompt. Infer the features from what a typical app of this kind does.

Rules:
- Put every test file in `{{test_dir}}/`. Only that folder is kept; changes to other files, the config included, are discarded.
- The project is ready to run. Do not install packages or change the config.
- Navigate with relative URLs only, for example `/`. The base URL is set for you, and the suite will also run against other instances of the app.
- Make each test independent of the others, and check what the user sees after each action.
[url] - Run the suite with `{{test_command}}` and fix it until every test passes on this app. That command is your only way to reach the app: you have no browser or network tool, so to look at a page, write a test that opens it and prints what you need.
