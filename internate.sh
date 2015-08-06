#!/bin/bash

NOISY=true
HUBPREFIX="your_docker_hub_username"
APPDIR=$(pwd)
CONFIGFILE=$(echo eval ~/.internate.conf)
DOCKER_BINARY=docker

function appdir() {
    # if there is a build directory configured in $CONFIGGILE, use that, otherwise look for a subdir of $APPDIR of the same name as the app
    if [ -e "$CONFIGFILE" ] 
    then
        appdir=$(awk -F ":" "/^$1\:/ {print \$2}" $CONFIGFILE)
    elif [ -d "$APPDIR/$1" ]
    then
        appdir="$APPDIR/$1"
    else
        echo "Cannot determine app directory for '$1'. There is no build directory configured in $CONFIGFILE, and also no subdirectory of '$(cd $APPFIR; pwd)' named '$1'." 1>&2
        exit 1;
    fi

    #believe it or not, this is the simplest way I've found of canonicalizing the path:
    eval echo $appdir 
}

function build() {
    cd $(appdir $1)
    tar -czh . | $DOCKER_BINARY build -t "$HUBPREFIX/$1" -
    cd $APPDIR
}

function push () {
    $DOCKER_BINARY push "$HUBPREFIX/$1"
}

function terminate() {
    $DOCKER_BINARY rm -f "$1" 2&> /dev/null
}

function resurrect() {
    echo "Resurrecting app in $(appdir "$1")."

    opts=$(cat $(appdir "$1")/internate.opts)
    $DOCKER_BINARY run --restart=always -d --name $1 $opts $HUBPREFIX/$1
}

for app in $@
do
    if $NOISY; then echo -e "--------------------\nBuilding app '$app'...\n--------------------"; fi
    build $app

    if $NOISY; then echo -e "--------------------\nTerminating existing container for app '$app'...\n--------------------"; fi
    terminate $app

    if $NOISY; then echo -e "--------------------\nRestarting app '$app' with configured options...\n--------------------"; fi
    resurrect $app
done
