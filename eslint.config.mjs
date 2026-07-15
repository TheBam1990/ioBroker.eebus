import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    files: ["test/**/*.js"],
    languageOptions: {
      globals: {
        after: "readonly",
        before: "readonly",
        describe: "readonly",
        it: "readonly",
      },
    },
  },
];
