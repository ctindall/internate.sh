#!/bin/bash

eval $(docker-machine env --shell bash "$1")

/usr/local/bin/docker rmi $(/usr/local/bin/docker images -qa) 2&> /dev/null
/usr/local/bin/docker rm $(/usr/local/bin/docker ps -qa) 2&> /dev/null

exit 0
