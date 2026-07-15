#!/bin/sh
JSON_OUTPUT=false
if [ "$1" = "-json" ]; then
    JSON_OUTPUT=true
    shift
fi
ADDITIONAL_ARGS=$*
EXIT_CODE=0
TEST_ROOT=$(pwd)

runTest() {
    TEST_BINARY=${1#./}
    TEST_PACKAGE=$2
    TEST_WORKING_DIRECTORY=${3:-.}
    if [ "$JSON_OUTPUT" = true ]; then
        STATUS_FILE="${TEST_ROOT}/.${TEST_BINARY}.status.$$"
        (
            cd "$TEST_WORKING_DIRECTORY" || exit 1
            if [ -n "$TEST_PACKAGE" ]; then
                "$TEST_ROOT/test2json" -p "$TEST_PACKAGE" \
                    -t "$TEST_ROOT/$TEST_BINARY" -test.v $ADDITIONAL_ARGS
            else
                "$TEST_ROOT/test2json" \
                    -t "$TEST_ROOT/$TEST_BINARY" -test.v $ADDITIONAL_ARGS
            fi
            printf '%s\n' "$?" > "$STATUS_FILE"
        ) | tee "$TEST_BINARY.result.json"
        TEE_STATUS=$?
        TEST_STATUS=1
        if [ -r "$STATUS_FILE" ]; then
            read -r TEST_STATUS < "$STATUS_FILE"
            rm -f "$STATUS_FILE"
        fi
        if [ "$TEST_STATUS" -ne 0 ] || [ "$TEE_STATUS" -ne 0 ]; then
            EXIT_CODE=1
        fi
    else
        if ! (
            cd "$TEST_WORKING_DIRECTORY" || exit 1
            "$TEST_ROOT/$TEST_BINARY" $ADDITIONAL_ARGS
        ); then
            EXIT_CODE=1
        fi
    fi
}

exit_with_code() {
    if [ $EXIT_CODE -ne 0 ]; then
        printf "\e[0;31m❌ Test failed\e[0m\n"
    fi

    exit $EXIT_CODE
}

trap exit_with_code EXIT
