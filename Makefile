.PHONY: setup dev verify test e2e build supabase-start supabase-stop supabase-reset backup

setup:
	npm run setup:app

dev:
	npm run dev

verify:
	npm run verify

test:
	npm test

e2e:
	npm run test:e2e

build:
	npm run build

supabase-start:
	npm run setup:app -- --with-supabase --skip-install

supabase-stop:
	npx --yes supabase@2.110.0 stop

supabase-reset:
	npx --yes supabase@2.110.0 db reset --local

backup:
	npm run backup
