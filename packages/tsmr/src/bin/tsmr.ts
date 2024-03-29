#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import { Command, program } from 'commander'
import shellQuote from 'shell-quote'
import { type PackageJson } from 'type-fest'

import { getTsmrConfig } from '~/utils/config.js'
import {
	getMonorepoDir,
	getPackageDir,
	shouldPackageBeChecked,
} from '~/utils/package.js'
import { turboLint, turboTypecheck } from '~/utils/turbo.js'
import {
	buildTypecheckFolder,
	deleteCachedTypecheckFiles,
	setupLintAndTypecheck,
	turboBuildTypecheckFolders,
	typecheck,
} from '~/utils/typecheck.js'

const getPackageSlugFromWorkingDirectory = async () => {
	const packageJsonPath = path.join(process.cwd(), 'package.json')
	if (!fs.existsSync(packageJsonPath)) {
		console.error('Unable to determine package from working directory')
		process.exit(1)
	}

	const packageJson = JSON.parse(
		await fs.promises.readFile(packageJsonPath, 'utf8')
	) as PackageJson
	if (packageJson.name === undefined) {
		console.error(
			`package.json at ${packageJsonPath} must have a name property`
		)
		process.exit(1)
	}

	return packageJson.name.split('/').at(-1)!
}

await program
	.name('tsmr')
	.addCommand(
		new Command('build-typecheck')
			.option('-p, --package <packageSlug>')
			.option('-t, --tsconfig <tsconfigFile>')
			.allowUnknownOption(true)
			.action(
				async (
					options: { package?: string; tsconfig?: string },
					command: Command
				) => {
					if (options.package === undefined) {
						options.package = await getPackageSlugFromWorkingDirectory()
					}

					const { exitCode } = await buildTypecheckFolder({
						packageSlug: options.package,
						logs: 'full',
						tsconfigFile: options.tsconfig,
						tscArguments: command.args,
					})

					process.exit(exitCode)
				}
			)
	)
	.addCommand(
		new Command('lint')
			.allowUnknownOption(true)
			.option('-p, --package <packageSlug>', 'the package to lint')
			.option('--verbose')
			.option('--only-show-errors')
			.option('--turbo-args <args>', 'a string of arguments to pass to Turbo')
			.action(
				async (
					options: {
						package?: string
						onlyShowErrors?: boolean
						turboArgs?: string
						verbose?: boolean
					},
					command: Command
				) => {
					if (options.package === undefined) {
						options.package = await getPackageSlugFromWorkingDirectory()
					}

					if (
						!(await shouldPackageBeChecked({ packageSlug: options.package }))
					) {
						console.info(`Skipping lint for package ${options.package}`)
						process.exit(0)
					}

					// We only run the `setupLintAndTypecheck` function if we're linting independently of Turbo.
					// Otherwise, we run this function once before running Turbo so we don't need to re-run it.
					if (process.env.TURBO_HASH === undefined) {
						const turboArguments =
							options.turboArgs === undefined
								? undefined
								: (shellQuote.parse(options.turboArgs) as string[])
						await setupLintAndTypecheck({
							logs: options.verbose ? 'full' : 'summary',
							turboArguments,
						})
					}

					const tsmrConfig = await getTsmrConfig()
					const packageDir = await getPackageDir({
						packageSlug: options.package,
					})
					process.chdir(packageDir)
					const eslintFlags = [
						'--cache',
						'--fix',
						...(tsmrConfig.lint?.args ?? []),
					]

					if (options.onlyShowErrors) {
						eslintFlags.push('--quiet')
					}

					const monorepoDir = getMonorepoDir()
					// Resolve `eslint` from the monorepo root
					const eslintBinPath = path.join(
						monorepoDir,
						'node_modules/eslint/bin/eslint.js'
					)

					process.argv = [
						process.argv[0]!,
						eslintBinPath,
						...eslintFlags,
						...command.args,
						'.',
					]

					await import(eslintBinPath)
				}
			)
	)
	.addCommand(
		new Command('typecheck')
			.allowUnknownOption(true)
			.option('--verbose')
			.option('-p, --package <packageSlug>')
			.option('-t, --tsconfig <tsconfigFile>')
			.option('--turbo-args <args>', 'a string of arguments to pass to Turbo')
			.allowUnknownOption(true)
			.action(
				async (options: {
					package?: string
					turboArgs?: string
					tsconfig?: string
					verbose?: boolean
				}) => {
					if (options.package === undefined) {
						options.package = await getPackageSlugFromWorkingDirectory()
					}

					if (
						!(await shouldPackageBeChecked({ packageSlug: options.package }))
					) {
						console.info(`Skipping typecheck for package ${options.package}`)
						process.exit(0)
					}

					// We only run the `setupLintAndTypecheck` function if we're typechecking independently of Turbo. Otherwise,
					// we run this function once before running Turbo so we don't need to re-run it.
					if (process.env.TURBO_HASH === undefined) {
						const turboArguments =
							options.turboArgs === undefined
								? undefined
								: (shellQuote.parse(options.turboArgs) as string[])
						await setupLintAndTypecheck({
							logs: options.verbose ? 'full' : 'summary',
							turboArguments,
						})
						console.info('Running typecheck...')
					}

					const result = await typecheck({
						packageSlug: options.package,
						tsconfigFile: options.tsconfig ?? 'tsconfig.json',
					})
					const exitCode = result?.exitCode ?? 0
					process.exit(exitCode)
				}
			)
	)
	.addCommand(
		new Command('turbo-build-typecheck')
			.option('-f, --force')
			.allowUnknownOption(true)
			.action(async (options: { force?: boolean }, command: Command) => {
				if (options.force) {
					console.info(
						'`--force` option detected; removing all typechecking caches and artifacts.'
					)

					await deleteCachedTypecheckFiles()

					console.info('Cached typecheck files removed.')
				}

				const turboArguments = options.force ? ['--force'] : []
				turboArguments.push(...command.args)
				console.info('Building typecheck folders with Turbo...')
				const { exitCode } = await turboBuildTypecheckFolders({
					logs: 'full',
					turboArguments,
				})
				process.exit(exitCode)
			})
	)
	.addCommand(
		new Command('turbo-lint')
			.option('-f, --force')
			.allowUnknownOption(true)
			.action(async (options: { force?: boolean }, command: Command) => {
				if (options.force) {
					console.info(
						'`--force` option detected; removing all cached lint files and artifacts.'
					)

					await deleteCachedTypecheckFiles()

					console.info('Cached lint files removed.')
				}

				const turboArguments = options.force ? ['--force'] : []
				turboArguments.push(...command.args)
				// Note that we don't need to call `generateDistTypecheckFolders` since we've patched ESLint to use the source files instead of the declarations
				await setupLintAndTypecheck({ logs: 'summary', turboArguments })
				const { exitCode } = await turboLint({
					logs: 'full',
					onlyShowErrors: false,
					turboArguments: command.args,
				})
				process.exit(exitCode)
			})
	)
	.addCommand(
		new Command('turbo-typecheck')
			.option('-f, --force')
			.allowUnknownOption(true)
			.action(async (options: { force?: boolean }, command: Command) => {
				if (options.force) {
					console.info(
						'`--force` option detected; removing all typechecking caches and artifacts.'
					)

					await deleteCachedTypecheckFiles()

					console.info('Cached typecheck files removed.')
				}

				const turboArguments = options.force ? ['--force'] : []
				turboArguments.push(...command.args)
				await setupLintAndTypecheck({ logs: 'summary', turboArguments })
				const { exitCode } = await turboTypecheck({
					logs: 'full',
					turboArguments,
				})
				process.exit(exitCode)
			})
	)
	.parseAsync()
