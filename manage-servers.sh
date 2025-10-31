#!/data/data/com.termux/files/usr/bin/bash

case "$1" in
  start)
    echo "🚀 Starting all servers..."
    
    # PostPay
    cd ~/postpay-platform
    node server.js > ~/logs/postpay.log 2>&1 &
    POSTPAY_PID=$!
    echo "✅ PostPay started (PID: $POSTPAY_PID) on port 3000"
    
    # Second App (if you have one)
    # cd ~/another-app
    # node app.js > ~/logs/app2.log 2>&1 &
    # APP2_PID=$!
    # echo "✅ App2 started (PID: $APP2_PID) on port 4000"
    
    # Save PIDs
    echo $POSTPAY_PID > ~/pids/postpay.pid
    # echo $APP2_PID > ~/pids/app2.pid
    
    echo ""
    echo "📊 All servers running!"
    echo "View processes: ps aux | grep node"
    ;;
    
  stop)
    echo "🛑 Stopping all servers..."
    
    # Stop by PID
    if [ -f ~/pids/postpay.pid ]; then
      kill $(cat ~/pids/postpay.pid)
      rm ~/pids/postpay.pid
      echo "✅ PostPay stopped"
    fi
    
    # Or kill all node processes
    # pkill node
    # echo "✅ All node servers stopped"
    ;;
    
  status)
    echo "📊 Server Status:"
    echo ""
    ps aux | grep node | grep -v grep
    echo ""
    echo "🌐 Ports in use:"
    netstat -tulpn | grep LISTEN | grep -E '3000|4000|5000'
    ;;
    
  logs)
    echo "📝 Server Logs:"
    echo ""
    echo "=== PostPay Log ==="
    tail -n 20 ~/logs/postpay.log
    ;;
    
  *)
    echo "Usage: $0 {start|stop|status|logs}"
    exit 1
    ;;
esac
