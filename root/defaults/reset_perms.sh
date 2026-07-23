while [ 1 ]
do
    if [ -f /config/reset_perms ]; 
    then
        echo "abc" | sudo -s chmod -R 777 /vaults /config
        echo "abc" | rm -rf /config/reset_perms
    fi
    sleep 1 # or less like 0.2
done