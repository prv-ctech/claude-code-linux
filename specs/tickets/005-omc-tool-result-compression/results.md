# 005-omc-tool-result-compression results

## compression
A-1 | PASS | validate loop exit 0 ("Validation passed"; rea-mod README install-line advisory only)
A-2 | PASS | node --test mods/oh-my-context-mod/test/*.test.js: 58 pass, 0 fail
A-3 | PASS | unittest discover mods/oh-my-context-mod/test: 69 tests OK
E-11 | PASS | eval command prints [] (also over tracked+untracked vendor files, so shapes/, toon.py, recovery.py included); stdlib imports only
R-1 | PASS | test_gateway.py within the 69 OK; bin/oh-my-context --version prints 0.8.33, exit 0
E-5 | PASS | PipelineTests.test_json_elision_and_recovery (23 compress tests ok)
E-6 | PASS | ToonTests
E-7 | PASS | PipelineTests test_testreport_pytest, test_diff, test_csv, test_python_code, test_log, test_text
E-8 | PASS | PipelineTests.test_passthrough, test_setting
E-9 | PASS | PipelineTests.test_no_old_path
E-10 | PASS | PipelineTests.test_speed (1 MiB log < 1 s)

## recovery
E-1 | PASS | test_store_fetch_exact
E-2 | PASS | test_corrupt_and_invalid
E-3 | PASS | test_cap_no_eviction
E-4 | PASS | test_query, test_retrieve_tool
A-1 | PASS | unittest test_compress RecoveryTests 8 ok
