#!/bin/bash
eval $(docker-machine env --shell bash "$1") && docker "${@:2}"
