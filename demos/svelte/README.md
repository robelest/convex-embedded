# sv

Everything you need to build a Svelte project, powered by
[`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
vp dlx sv@0.12.5 create --template minimal --types ts --install pnpm svelte
```

## Developing

Once you've created a project and installed dependencies with `vp install`,
start a development server:

```sh
vp dev

# or start the server and open the app in a new browser tab
vp dev -- --open
```

## Building

To create a production version of your app:

```sh
vp build
```

You can preview the production build with `vp preview`.

> To deploy your app, you may need to install an
> [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
